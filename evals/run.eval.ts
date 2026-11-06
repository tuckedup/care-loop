import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  gateFailures,
  loadCases,
  runCase,
  writeResults,
  type CaseResult,
} from "./lib";
import type { EvalCase } from "./schema";

type Loaded = { ok: true; cases: EvalCase[] } | { ok: false; error: unknown };
const loaded: Loaded = (() => {
  try {
    return { ok: true, cases: loadCases() };
  } catch (error) {
    return { ok: false, error };
  }
})();

describe("eval suite", () => {
  if (!loaded.ok) {
    // Zero cases / unreadable / schema-invalid cases fail the run (the gate fails closed).
    it("loads a non-empty, schema-valid case set", () => {
      throw loaded.error;
    });
    return;
  }
  const results: CaseResult[] = loaded.cases.map((c) => runCase(c));

  for (const r of results) {
    it(`${r.id}`, () => {
      expect(r.actualOutcome).toBe(r.expectedOutcome);
      expect([...r.actualReasonCodes].sort()).toEqual([...r.expectedReasonCodes].sort());
    });
  }

  it("gate: escalation recall 1.0, no unsafe approvals; writes latest.json", () => {
    const metrics = computeMetrics(results, process.env.EVAL_LIVE === "1" ? "live" : "rules-only");
    writeResults(metrics, results);
    expect(gateFailures(metrics)).toEqual([]);
  });
});
