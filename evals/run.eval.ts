import { describe, expect, it } from "vitest";
import { loadAiConfig } from "../src/ai/config";
import { runAiStage } from "./ai-runner";
import { runJudgeEval } from "./judge-eval";
import {
  computeMetrics,
  dirLabel,
  envGuardFailures,
  gateFailures,
  loadCases,
  loadManifest,
  manifestFailures,
  runCase,
  writeResults,
  type CaseResult,
  type CitationStats,
  type CoverageExtras,
} from "./lib";
import type { EvalCase } from "./schema";

const LIVE = process.env.EVAL_LIVE === "1";

type Loaded =
  | { ok: true; results: CaseResult[]; citations: CitationStats; extras: CoverageExtras }
  | { ok: false; error: unknown };

async function load(): Promise<Loaded> {
  try {
    // Fail before running anything (and before any file is written) on a bad environment.
    const envFailures = envGuardFailures();
    if (envFailures.length > 0) throw new Error(`eval gate: ${envFailures.join("; ")}`);
    if (LIVE) {
      const cfg = loadAiConfig();
      if (!cfg.apiKey || !cfg.model) {
        throw new Error(
          "EVAL_LIVE=1 requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL; nothing was run or written",
        );
      }
    }
    const cases: EvalCase[] = loadCases();
    const manifest = loadManifest();
    const results: CaseResult[] = [];
    const citations: CitationStats = {
      modelSignals: 0,
      modelSignalsVerified: 0,
      tripwireSignals: 0,
    };
    let blockedAiCases = 0;
    let llmCallsOnBlocked = 0;
    for (const c of cases) {
      if (!c.aiFixture) {
        // Rules-only case: AI result is "ok, no signals".
        results.push(runCase(c));
        continue;
      }
      const stage = await runAiStage(c, LIVE);
      if (stage.skipped) continue;
      results.push({ ...runCase(c, stage.ai), ai: stage.obs });
      citations.modelSignals += stage.modelSignals;
      citations.modelSignalsVerified += stage.modelSignalsVerified;
      citations.tripwireSignals += stage.tripwireSignals;
      if (stage.blocked) {
        blockedAiCases += 1;
        llmCallsOnBlocked += stage.calls;
      }
    }
    const extras: CoverageExtras = {
      manifestFailures: manifestFailures(manifest, cases, results),
      casesDirLabel: dirLabel("EVAL_CASES_DIR"),
      fixturesDirLabel: dirLabel("EVAL_FIXTURES_DIR"),
      blockedAiCases,
      llmCallsOnBlocked,
      envFailures,
      judge: await runJudgeEval(LIVE),
    };
    return { ok: true, results, citations, extras };
  } catch (error) {
    return { ok: false, error };
  }
}

const loaded = await load();

describe("eval suite", () => {
  if (!loaded.ok) {
    // Zero cases / unreadable / schema-invalid cases / missing fixtures / bad env fail the run.
    it("loads a non-empty, schema-valid case set in a permitted environment", () => {
      throw loaded.error;
    });
    return;
  }
  const { results, citations, extras } = loaded;

  for (const r of results) {
    it(`${r.id}`, () => {
      expect(r.actualOutcome).toBe(r.expectedOutcome);
      expect([...r.actualReasonCodes].sort()).toEqual([...r.expectedReasonCodes].sort());
    });
  }

  it("gate: recall 1.0, citation validity 1.0, coverage manifest, no unsafe approvals; writes results", () => {
    const usesAi = results.length > 0 && results.some((r) => r.usedAi);
    const mode = LIVE ? "live" : usesAi ? "fixtures" : "rules-only";
    const metrics = computeMetrics(results, mode, citations, extras);
    writeResults(metrics, results);
    expect(gateFailures(metrics)).toEqual([]);
  });
});
