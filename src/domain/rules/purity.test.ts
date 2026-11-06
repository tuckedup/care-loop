import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "./evaluate";
import { baseInput } from "./fixtures";
import type { RuleInput } from "./types";

const dir = __dirname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "fixtures.ts")
  .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const)
  .concat([["../formulary.ts", readFileSync(join(dir, "..", "formulary.ts"), "utf8")] as const]);

// Strip comments so prose in docs cannot trigger or hide matches.
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("rules purity", () => {
  it("finds the rule sources", () => {
    expect(sources.length).toBeGreaterThanOrEqual(12);
  });

  const forbidden: Array<[string, RegExp]> = [
    ["Date.now", /Date\s*\.\s*now/],
    ["Date.parse", /Date\s*\.\s*parse/],
    ["Date.UTC", /Date\s*\.\s*UTC/],
    ["new Date", /new\s+Date\b/],
    ["Date()", /\bDate\s*\(/],
    ["Math.random", /Math\s*\.\s*random/],
    ["performance.now", /performance\s*\.\s*now/],
    ["process.env", /process\s*\.\s*env/],
    ["fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest/WebSocket", /\b(XMLHttpRequest|WebSocket)\b/],
    ["console", /\bconsole\s*\./],
    ["timers", /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/],
    ["crypto.randomUUID", /randomUUID/],
    ["crypto.getRandomValues", /getRandomValues/],
    ["crypto.randomBytes/randomInt", /randomBytes|randomInt/],
    ["crypto global", /\bcrypto\s*\./],
    ["require(", /\brequire\s*\(/],
    ["dynamic import", /\bimport\s*\(/],
    ["side-effect import", /(^|\n)\s*import\s*["']/],
    ["node: builtin import", /["']node:/],
    ["bare builtin import", /from\s*["'](fs|path|os|crypto|http|https|net|child_process|url)["']/],
  ];

  it.each(sources)("%s has no forbidden calls", (_f, src) => {
    const c = code(src);
    for (const [name, re] of forbidden) {
      expect(re.test(c), `${name} found`).toBe(false);
    }
  });

  it("the forbidden-pattern list actually detects each hazard", () => {
    const samples = [
      'import "fs";',
      "const t = Date.parse('x');",
      "const t = Date.UTC(1);",
      "Date.now()",
      "performance.now()",
      "crypto.randomUUID()",
      "crypto.getRandomValues(a)",
      "process.env.X",
      "await fetch(u)",
      "const f = require('fs')",
      "Math.random()",
    ];
    for (const sample of samples) {
      expect(
        forbidden.some(([, re]) => re.test(sample)),
        sample,
      ).toBe(true);
    }
  });

  // Aliasing guard: ambient-global identifiers must not appear at all (catches
  // `const D = globalThis["Da"+"te"]`, `const M = Math`, `Reflect`/`Proxy` tricks and so on).
  // Explicit per-file allowlist; currently nothing needs any of them.
  const AMBIENT =
    /\b(Date|Math|process|globalThis|global|window|self|Reflect|Proxy|Intl|eval|Function)\b/;
  const AMBIENT_ALLOW: Record<string, string[]> = {};

  it.each(sources)("%s uses no ambient globals beyond its allowlist", (f, src) => {
    const hits = [...code(src).matchAll(new RegExp(AMBIENT.source, "g"))].map((m) => m[1]!);
    const allowed = AMBIENT_ALLOW[f] ?? [];
    expect(hits.filter((h) => !allowed.includes(h))).toEqual([]);
  });

  it("the ambient-global pattern detects aliasing attempts", () => {
    for (const s of [
      'globalThis["Date"]',
      "const M = Math;",
      "new Proxy(a, b)",
      "Reflect.get(a)",
      "process",
    ]) {
      expect(AMBIENT.test(s), s).toBe(true);
    }
  });

  it.each(sources)("%s imports only sibling rule modules or the pure formulary", (_f, src) => {
    const c = code(src);
    const specs = [...c.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const s of specs) {
      expect(s, `import ${s}`).toMatch(
        /^\.\/[\w-]+$|^\.\.\/formulary$|^\.\.\/\.\.\/data\/rxnorm-cache\.json$/,
      );
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
