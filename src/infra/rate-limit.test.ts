import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, enforceRateLimit, loginLimit, rateLimit, resetRateLimits } from "./rate-limit";

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("allows up to the limit then blocks, per key", () => {
    const cfg = { limit: 3, windowMs: 1000 };
    expect([1, 2, 3].map(() => rateLimit("a", cfg, 0).ok)).toEqual([true, true, true]);
    const blocked = rateLimit("a", cfg, 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rateLimit("b", cfg, 10).ok).toBe(true);
  });

  it("resets after the window", () => {
    const cfg = { limit: 1, windowMs: 1000 };
    expect(rateLimit("a", cfg, 0).ok).toBe(true);
    expect(rateLimit("a", cfg, 500).ok).toBe(false);
    expect(rateLimit("a", cfg, 1001).ok).toBe(true);
  });
});

describe("clientIp", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  it("uses the rightmost x-forwarded-for entry, then x-real-ip, else unknown", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(h({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(h({}))).toBe("unknown");
  });
});

describe("enforceRateLimit", () => {
  it("returns a 429 with Retry-After once over budget", async () => {
    const req = () => new Request("http://x/api", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(enforceRateLimit(req(), "r", { limit: 1, windowMs: 60_000 })).toBeNull();
    const res = enforceRateLimit(req(), "r", { limit: 1, windowMs: 60_000 });
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBeTruthy();
    expect(await res?.json()).toEqual({ error: "rate_limited" });
  });
});

describe("loginLimit", () => {
  it("defaults to 20 per minute and accepts a positive integer override", () => {
    expect(loginLimit({}).limit).toBe(20);
    expect(loginLimit({ LOGIN_RATE_LIMIT_PER_MIN: "" }).limit).toBe(20);
    expect(loginLimit({ LOGIN_RATE_LIMIT_PER_MIN: "0" }).limit).toBe(20);
    expect(loginLimit({ LOGIN_RATE_LIMIT_PER_MIN: "5" }).limit).toBe(5);
  });
});
