// F058: every external HTTP call in non-test source carries an idempotency key.
// A grep-style scan: each `fetch(` / `doFetch(` call site must pass an Idempotency-Key header in
// its own argument list. The only exception is the Anthropic SDK call (read-only inference, no
// side effect; documented in docs/DECISIONS.md). Any NEW call site that is not covered fails here,
// so a new external call cannot be added without a key or an explicit, reviewed exception.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|eval|spec)\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The text between the parentheses that open at `open` (string and template aware enough). */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

interface CallSite {
  file: string;
  line: number;
  callee: string;
  args: string;
}

function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  const files = [...walk(join(root, "src")), ...walk(join(root, "scripts"))];
  const pattern = /(?<![\w.])(doFetch|fetch)\(|\.messages\.create\(|\bnew Anthropic\(/g;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(pattern)) {
      const open = m.index! + m[0].length - 1;
      const text = m[0].startsWith("new Anthropic") || m[0].includes("messages") ? m[0] : m[1]!;
      sites.push({
        file: relative(root, file).replace(/\\/g, "/"),
        line: src.slice(0, m.index).split("\n").length,
        callee: text.replace(/\($/, ""),
        args: argsAt(src, open),
      });
    }
  }
  return sites;
}

/** Reviewed exceptions: the call has no external side effect or only forwards an init object. */
const EXCEPTIONS: { file: string; callee: RegExp; why: string }[] = [
  {
    file: "src/ai/client.ts",
    callee: /messages\.create|new Anthropic/,
    why: "read-only LLM inference, no side effect (docs/DECISIONS.md); the SDK has no idempotency key",
  },
  {
    file: "src/ai/tracing.ts",
    callee: /^fetch$/,
    why: "thin wrapper (url, init) => fetch(url, init); the doFetch call site builds the header",
  },
];

describe("external HTTP calls carry an idempotency key", () => {
  const sites = callSites();

  it("finds the known call sites (the scan is not vacuous)", () => {
    const where = sites.map((s) => `${s.file}:${s.callee}`);
    expect(where.filter((w) => w.startsWith("src/infra/outbox/transmit.ts:doFetch")).length).toBe(
      2,
    );
    expect(where).toContain("src/ai/tracing.ts:doFetch");
    expect(where.some((w) => w.startsWith("src/ai/client.ts:"))).toBe(true);
  });

  it("every call site passes an Idempotency-Key header, or is a reviewed exception", () => {
    const missing = sites.filter((s) => {
      if (/idempotency-key/i.test(s.args)) return false;
      return !EXCEPTIONS.some((e) => e.file === s.file && e.callee.test(s.callee));
    });
    expect(missing.map((s) => `${s.file}:${s.line} ${s.callee}(...)`)).toEqual([]);
  });

  it("the exception list stays minimal and each entry is still needed", () => {
    for (const e of EXCEPTIONS) {
      expect(
        sites.some((s) => s.file === e.file && e.callee.test(s.callee)),
        `exception for ${e.file} (${e.why}) matches no call site`,
      ).toBe(true);
    }
    expect(EXCEPTIONS).toHaveLength(2);
  });

  it("the outbox transmit and cancel calls use the outbox message idempotency key", () => {
    const transmit = sites.filter((s) => s.file === "src/infra/outbox/transmit.ts");
    expect(transmit.length).toBe(2);
    for (const s of transmit)
      expect(s.args).toMatch(/"idempotency-key":\s*message\.idempotencyKey/);
  });
});
