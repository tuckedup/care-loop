// Proves the eval gate fails closed: zero cases, invalid cases and recall < 1 all fail `pnpm eval`.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeMetrics, gateFailures, loadCases, type CaseResult } from "../evals/lib";

const root = resolve(__dirname, "..");
const tmpDirs: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "careloop-eval-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the real eval suite (same config as `pnpm eval`) against a case dir. */
function runEval(casesDir: string) {
  const results = join(mk(), "latest.json");
  const r = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.eval.config.ts",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EVAL_CASES_DIR: casesDir, EVAL_RESULTS_PATH: results, EVAL_LIVE: "" },
    },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, results };
}

const result = (o: Partial<CaseResult>): CaseResult => ({
  id: "x",
  category: "c",
  expectedOutcome: "ESCALATE",
  actualOutcome: "ESCALATE",
  expectedReasonCodes: [],
  actualReasonCodes: [],
  outcomeMatch: true,
  reasonsMatch: true,
  ...o,
});

describe("eval gate (unit)", () => {
  it("loadCases throws on an empty directory", () => {
    expect(() => loadCases(mk())).toThrow(/zero cases/);
  });

  it("loadCases throws on a schema-invalid case", () => {
    const d = mk();
    writeFileSync(join(d, "bad.json"), JSON.stringify({ id: "bad" }));
    expect(() => loadCases(d)).toThrow(/invalid eval case/);
  });

  it("zero results fail the gate", () => {
    expect(gateFailures(computeMetrics([], "rules-only")).join()).toMatch(/zero eval cases/);
  });

  it("recall < 1 fails the gate", () => {
    const m = computeMetrics(
      [
        result({ id: "a" }),
        result({ id: "b", actualOutcome: "AUTO_ELIGIBLE", outcomeMatch: false }),
      ],
      "rules-only",
    );
    expect(m.escalationRecall).toBe(0.5);
    expect(gateFailures(m).join()).toMatch(/escalation recall 0.5/);
    expect(m.unsafeApprovals).toBe(1);
  });

  it("recall 1.0 with matching labels passes the gate", () => {
    const m = computeMetrics([result({ id: "a" })], "rules-only");
    expect(m.escalationRecall).toBe(1);
    expect(gateFailures(m)).toEqual([]);
  });

  it("an unsafe approval fails the gate even for a non-ESCALATE label", () => {
    const m = computeMetrics(
      [
        result({ id: "a" }),
        result({
          id: "b",
          expectedOutcome: "REJECT",
          actualOutcome: "AUTO_ELIGIBLE",
          outcomeMatch: false,
        }),
      ],
      "rules-only",
    );
    expect(gateFailures(m).join()).toMatch(/unsafe auto-approval/);
  });
});

describe("pnpm eval process exit code", () => {
  it("fails (non-zero) on an empty case directory", () => {
    const r = runEval(mk());
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/zero cases/);
  }, 120_000);

  it("fails (non-zero) when a mislabelled case makes recall < 1", () => {
    const d = mk();
    // Clean renewal labeled ESCALATE: the system says AUTO_ELIGIBLE, so recall is 0.
    const src = join(root, "evals", "cases", "clean-renewal-fluoxetine.json");
    const c = JSON.parse(readFileSync(src, "utf8"));
    c.expected = { outcome: "ESCALATE", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] };
    writeFileSync(join(d, "clean-renewal-fluoxetine.json"), JSON.stringify(c));
    const r = runEval(d);
    expect(r.status).not.toBe(0);
    const written = JSON.parse(readFileSync(r.results, "utf8"));
    expect(written.escalationRecall).toBe(0);
    expect(written.gate).toBe("fail");
  }, 120_000);

  it("passes on the committed seed cases and records recall 1.0", () => {
    const d = mk();
    const src = join(root, "evals", "cases");
    for (const f of readdirSync(src)) cpSync(join(src, f), join(d, f));
    const r = runEval(d);
    expect(r.status).toBe(0);
    expect(existsSync(r.results)).toBe(true);
    const written = JSON.parse(readFileSync(r.results, "utf8"));
    expect(written.escalationRecall).toBe(1);
    expect(written.totalCases).toBeGreaterThanOrEqual(8);
  }, 120_000);
});
