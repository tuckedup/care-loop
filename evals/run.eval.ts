import { describe, expect, it } from "vitest";
import { runAiStage } from "./ai-runner";
import {
  computeMetrics,
  type CitationStats,
  gateFailures,
  loadCases,
  runCase,
  writeResults,
  type CaseResult,
} from "./lib";
import type { EvalCase } from "./schema";

const LIVE = process.env.EVAL_LIVE === "1";

type Loaded =
  | { ok: true; results: CaseResult[]; citations: CitationStats }
  | { ok: false; error: unknown };

async function load(): Promise<Loaded> {
  try {
    const cases: EvalCase[] = loadCases();
    const results: CaseResult[] = [];
    const citations: CitationStats = {
      modelSignals: 0,
      modelSignalsVerified: 0,
      tripwireSignals: 0,
    };
    for (const c of cases) {
      if (!c.aiFixture) {
        // Rules-only case: AI result is "ok, no signals".
        results.push(runCase(c));
        continue;
      }
      const stage = await runAiStage(c, LIVE);
      if (stage.skipped) continue;
      results.push(runCase(c, stage.ai));
      citations.modelSignals += stage.modelSignals;
      citations.modelSignalsVerified += stage.modelSignalsVerified;
      citations.tripwireSignals += stage.tripwireSignals;
    }
    return { ok: true, results, citations };
  } catch (error) {
    return { ok: false, error };
  }
}

const loaded = await load();

describe("eval suite", () => {
  if (!loaded.ok) {
    // Zero cases / unreadable / schema-invalid cases / missing fixtures fail the run.
    it("loads a non-empty, schema-valid case set", () => {
      throw loaded.error;
    });
    return;
  }
  const { results, citations } = loaded;

  for (const r of results) {
    it(`${r.id}`, () => {
      expect(r.actualOutcome).toBe(r.expectedOutcome);
      expect([...r.actualReasonCodes].sort()).toEqual([...r.expectedReasonCodes].sort());
    });
  }

  it("gate: escalation recall 1.0, citation validity 1.0, no unsafe approvals; writes latest.json", () => {
    const usesAi = results.length > 0 && results.some((r) => r.usedAi);
    const mode = LIVE ? "live" : usesAi ? "fixtures" : "rules-only";
    const metrics = computeMetrics(results, mode, citations);
    writeResults(metrics, results);
    expect(gateFailures(metrics)).toEqual([]);
  });
});
