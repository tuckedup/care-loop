import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "./evaluate";
import { baseInput } from "./fixtures";
import type { RuleInput } from "./types";

const dir = __dirname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "fixtures.ts")
  .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

// Strip comments so prose in docs cannot trigger or hide matches.
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("rules purity", () => {
  it("finds the rule sources", () => {
    expect(sources.length).toBeGreaterThanOrEqual(12);
  });

  const forbidden: Array<[string, RegExp]> = [
    ["Date.now", /Date\.now/],
    ["new Date", /new\s+Date\b/],
    ["Date()", /\bDate\(/],
    ["Math.random", /Math\.random/],
    ["performance.now", /performance\.now/],
    ["process.env", /process\.env/],
    ["fetch", /\bfetch\s*\(/],
    ["console", /\bconsole\./],
    ["timers", /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/],
    ["crypto random", /\brandomUUID|getRandomValues|randomBytes\b/],
    ["require", /\brequire\s*\(/],
    ["dynamic import", /\bimport\s*\(/],
  ];

  it.each(sources)("%s has no forbidden calls", (_f, src) => {
    const c = code(src);
    for (const [name, re] of forbidden) {
      expect(re.test(c), `${name} found`).toBe(false);
    }
  });

  it.each(sources)("%s imports only sibling rule modules or the pure formulary", (_f, src) => {
    const specs = [...code(src).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const s of specs) {
      expect(s, `import ${s}`).toMatch(/^\.\/[\w-]+$|^\.\.\/formulary$/);
    }
  });
});

describe("evaluateEligibility determinism", () => {
  it("same input gives deep-equal output, repeatedly", () => {
    const input = baseInput({ renewalsSinceLastVisit: 2, requestedChange: "dose" });
    const first = evaluateEligibility(input);
    for (let i = 0; i < 5; i++) expect(evaluateEligibility(input)).toEqual(first);
  });

  it("does not mutate its input (deep-frozen input works)", () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object") {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    const input = deepFreeze(structuredClone(baseInput()));
    const snapshot = structuredClone(input);
    expect(evaluateEligibility(input)).toEqual(evaluateEligibility(snapshot as RuleInput));
    expect(input).toEqual(snapshot);
  });

  it("output does not depend on environment or time", () => {
    const input = baseInput();
    const a = evaluateEligibility(input);
    const prev = process.env.REFILL_LIMIT;
    process.env.REFILL_LIMIT = "99";
    try {
      expect(evaluateEligibility(input)).toEqual(a);
    } finally {
      if (prev === undefined) delete process.env.REFILL_LIMIT;
      else process.env.REFILL_LIMIT = prev;
    }
  });
});
