// F069 hardening assertions: cron routes are secret-protected, security headers are configured,
// rate limiting is present, and the production guards hold. Static checks read the real config files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forcedScenario } from "../src/app/api/mock-pharmacy/simulate";
import { resetRateLimits } from "../src/infra/rate-limit";

vi.mock("server-only", () => ({}));

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

beforeEach(() => resetRateLimits());
afterEach(() => vi.unstubAllEnvs());

const CRON_ROUTES = ["outbox", "decisions", "visits"] as const;
type Handler = (r: Request) => Promise<Response>;

async function cronHandler(name: (typeof CRON_ROUTES)[number]): Promise<Handler> {
  const mod = (await import(`../src/app/api/cron/${name}/route.ts`)) as { GET: Handler };
  return mod.GET;
}

describe("cron routes are secret-protected", () => {
  for (const name of CRON_ROUTES) {
    it(`/api/cron/${name}: 401 without a header, with a wrong secret, and when CRON_SECRET is unset`, async () => {
      const GET = await cronHandler(name);
      const url = `http://localhost/api/cron/${name}`;
      const withAuth = (authorization: string) => new Request(url, { headers: { authorization } });
      vi.stubEnv("CRON_SECRET", "s3cret-value");
      expect((await GET(new Request(url))).status).toBe(401);
      expect((await GET(withAuth("Bearer nope"))).status).toBe(401);
      expect((await GET(withAuth("s3cret-value"))).status).toBe(401);
      vi.stubEnv("CRON_SECRET", "");
      expect((await GET(withAuth("Bearer "))).status).toBe(401);
      expect((await GET(withAuth("Bearer undefined"))).status).toBe(401);
    });

    it(`/api/cron/${name}: is rate limited (429 with Retry-After) ahead of the secret check`, async () => {
      const GET = await cronHandler(name);
      vi.stubEnv("CRON_SECRET", "s3cret-value");
      const mk = () =>
        new Request(`http://localhost/api/cron/${name}`, {
          headers: { "x-forwarded-for": "7.7.7.7" },
        });
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await GET(mk())).status);
      expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
      expect((await GET(mk())).headers.get("retry-after")).toBeTruthy();
    });
  }

  it("vercel.json schedules exactly the three cron routes", () => {
    const cfg = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons.map((c) => c.path).sort()).toEqual(
      CRON_ROUTES.map((n) => `/api/cron/${n}`).sort(),
    );
    for (const c of cfg.crons) expect(c.schedule.split(" ")).toHaveLength(5);
  });
});

describe("rate limiting is present on the mock pharmacy and login", () => {
  it("/api/mock-pharmacy answers 429 after the per-IP budget", async () => {
    const { POST } = await import("../src/app/api/mock-pharmacy/route");
    const mk = () =>
      new Request("http://localhost/api/mock-pharmacy", {
        method: "POST",
        headers: { "x-forwarded-for": "8.8.8.8" },
        body: "not json",
      });
    let last = 0;
    let firstBlocked = -1;
    for (let i = 1; i <= 125; i++) {
      last = (await POST(mk())).status;
      if (last === 429 && firstBlocked < 0) firstBlocked = i;
    }
    expect(last).toBe(429);
    expect(firstBlocked).toBe(121);
  });

  it("the login action is throttled and fails closed without a usable secret", () => {
    const src = read("src/app/(auth)/login/actions.ts");
    expect(src).toContain("rateLimit(");
    expect(src).toContain("loginLimit()");
    expect(src).toContain("demoAuthEnabled()");
    expect(src).toContain("getSecret()");
  });

  it("every limited route calls the shared limiter", () => {
    for (const p of [
      "src/app/api/mock-pharmacy/route.ts",
      ...CRON_ROUTES.map((n) => `src/app/api/cron/${n}/route.ts`),
    ]) {
      expect(read(p), p).toContain("enforceRateLimit(");
    }
  });
});

describe("security headers (next.config.ts)", () => {
  async function loadHeaders(env: "production" | "test") {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", env);
    const mod = (await import("../next.config")) as {
      default: {
        poweredByHeader?: boolean;
        outputFileTracingIncludes?: Record<string, string[]>;
        headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
      };
    };
    const rules = await mod.default.headers();
    const map = new Map(rules.flatMap((r) => r.headers.map((h) => [h.key, h.value] as const)));
    return { cfg: mod.default, rules, map };
  }

  it("sets the baseline headers on every path in production", async () => {
    const { cfg, rules, map } = await loadHeaders("production");
    expect(rules[0]?.source).toBe("/:path*");
    expect(cfg.poweredByHeader).toBe(false);
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toMatch(/camera=\(\)/);
    expect(map.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    const csp = map.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("only non-production builds allow unsafe-eval and skip HSTS", async () => {
    const { map } = await loadHeaders("test");
    expect(map.get("Content-Security-Policy")).toContain("'unsafe-eval'");
    expect(map.has("Strict-Transport-Security")).toBe(false);
  });

  it("traces the eval results into the /admin/evals bundle", async () => {
    const { cfg } = await loadHeaders("production");
    expect(cfg.outputFileTracingIncludes?.["/admin/evals"]).toContain("./evals/results/*.json");
  });
});

describe("production guards", () => {
  it("ignores every dev/test-only switch under NODE_ENV=production", async () => {
    const { DEV_TEST_ONLY_SWITCHES } = await import("../src/infra/auth/production-guards");
    const { riskFixtureEnabled } = await import("../src/app/patient/_lib/post-checkin");
    const { summaryDepsFromEnv } = await import("../src/app/clinician/_lib/summary");
    const { signingNow } = await import("../src/domain/visit/clock");
    const real = new Date("2026-01-01T00:00:00Z");
    // One probe per switch, each configured to be ON, evaluated under production and then test.
    const probes: Record<(typeof DEV_TEST_ONLY_SWITCHES)[number], (nodeEnv: string) => boolean> = {
      MOCK_PHARMACY_FORCE: (NODE_ENV) =>
        forcedScenario({ NODE_ENV, MOCK_PHARMACY_FORCE: "retry-then-fill" }) !== undefined,
      RISK_FIXTURE: (NODE_ENV) =>
        riskFixtureEnabled({ NODE_ENV, RISK_FIXTURE: "synthetic-handwritten" }),
      SUMMARY_FIXTURE: (NODE_ENV) =>
        summaryDepsFromEnv({ NODE_ENV, SUMMARY_FIXTURE: "synthetic-handwritten" }).model ===
        "synthetic-handwritten-fixture",
      VISIT_CLOCK_OFFSET_DAYS: (NODE_ENV) =>
        signingNow(real, { NODE_ENV, VISIT_CLOCK_OFFSET_DAYS: "60" }).getTime() !== real.getTime(),
    };
    expect(Object.keys(probes).sort()).toEqual([...DEV_TEST_ONLY_SWITCHES].sort());
    for (const name of DEV_TEST_ONLY_SWITCHES) {
      expect(probes[name]("production"), `${name} must be ignored in production`).toBe(false);
      expect(probes[name]("Production"), `${name} must be ignored for odd NODE_ENV`).toBe(false);
      expect(probes[name]("test"), `${name} probe is live under test (sanity)`).toBe(true);
    }
  });

  it(".env.example documents the switches only as commented-out lines", () => {
    const text = read(".env.example");
    const lines = text.split("\n");
    for (const name of [
      "MOCK_PHARMACY_FORCE",
      "RISK_FIXTURE",
      "SUMMARY_FIXTURE",
      "VISIT_CLOCK_OFFSET_DAYS",
    ]) {
      expect(
        lines.some((l) => l.startsWith(`${name}=`)),
        `${name} must not be active`,
      ).toBe(false);
      expect(
        lines.some((l) => l.startsWith(`# ${name}=`)),
        `${name} must be listed`,
      ).toBe(true);
    }
    expect(text).toContain("NEVER set these in production");
  });

  it("the demo role switcher is gated and labelled, and the e2e server opts in explicitly", () => {
    const page = read("src/app/(auth)/login/page.tsx");
    expect(page).toContain("demoAuthEnabled()");
    expect(page).toContain("demo-auth-disabled");
    expect(page).toContain("demo-auth-label");
    expect(read("src/infra/auth/guard.ts")).toContain("demoAuthEnabled()");
    expect(read("playwright.config.ts")).toMatch(/DEMO_AUTH_ENABLED:\s*"true"/);
  });

  it("the placeholder in .env.example equals the guard's constant", async () => {
    const { DEV_PLACEHOLDER_SECRET } = await import("../src/infra/auth/production-guards");
    expect(read(".env.example")).toContain(`SESSION_SECRET=${DEV_PLACEHOLDER_SECRET}`);
  });
});
