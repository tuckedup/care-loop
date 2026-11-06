// Runs the AI stage of the pipeline for one eval case, using a fixture-backed (recorded-style)
// client by default or the live Anthropic client when EVAL_LIVE=1. The live path is implemented
// but was NOT exercised in this repo (no API key was available).
import { createAnthropicClient, createRecordedClient, type RiskLlmClient } from "../src/ai/client";
import { detectInjection } from "../src/ai/injection";
import { loadAiConfig } from "../src/ai/config";
import { runRiskExtraction, toRulesAiResult } from "../src/ai/fail-closed";
import { isAiPathPermitted } from "../src/ai/ai-path-gate";
import { loadFixture } from "./fixtures";
import { toRuleInput, type AiForRules, type AiObservation } from "./lib";
import type { EvalCase } from "./schema";

export interface AiStageResult {
  ai: AiForRules;
  /** Model calls made. Must be 0 for controlled medications. */
  calls: number;
  /** Model-produced signals (tripwire signals are excluded). */
  modelSignals: number;
  modelSignalsVerified: number;
  /** Locally produced tripwire / injection signals, reported separately. */
  tripwireSignals: number;
  /** The medication was blocked from the AI path (positive allow-list). */
  blocked: boolean;
  /** Excluded from this run (fixture-only case during a live run). */
  skipped: boolean;
  /** Observations stored on the case result and checked by the manifest. */
  obs: AiObservation;
}

const NEVER = () => new Promise<string>(() => {});

export async function runAiStage(c: EvalCase, live: boolean): Promise<AiStageResult> {
  if (!c.aiFixture) {
    throw new Error(`case ${c.id} has no aiFixture; rules-only cases do not run the AI stage`);
  }
  const fixture = loadFixture(c.aiFixture);
  if (live && !fixture.header.liveApplicable) {
    return {
      ai: { status: "ok", signals: [] },
      calls: 0,
      modelSignals: 0,
      modelSignalsVerified: 0,
      tripwireSignals: 0,
      blocked: false,
      skipped: true,
      obs: {
        status: "ok",
        modelSignals: 0,
        tripwireSignals: 0,
        totalSignals: 0,
        injectionHits: 0,
        calls: 0,
        blocked: false,
      },
    };
  }

  let client: RiskLlmClient & { calls?: unknown[] };
  let model: string | undefined;
  let counted: { calls: unknown[] } | null = null;
  if (live) {
    const cfg = loadAiConfig();
    model = cfg.model;
    const inner = cfg.apiKey ? createAnthropicClient({ apiKey: cfg.apiKey }) : null;
    const calls: unknown[] = [];
    counted = { calls };
    client = {
      complete: (req) => {
        calls.push(req);
        if (!inner) throw new Error("ANTHROPIC_API_KEY unset");
        return inner.complete(req);
      },
    };
  } else {
    model = "fixture-model";
    const rec = createRecordedClient(() => {
      const r = fixture.response;
      if (r.type === "text") return r.text;
      if (r.error === "http_500") throw new Error("500 Internal Server Error (fixture)");
      return NEVER();
    });
    client = rec;
    counted = rec;
  }

  const ruleInput = toRuleInput(c, { status: "failed" });
  const result = await runRiskExtraction(
    ruleInput,
    { freeText: c.input.freeText, sideEffects: c.input.sideEffects },
    {
      client: live && !loadAiConfig().apiKey ? null : client,
      model,
      timeoutMs: live ? 60_000 : 50,
    },
  );
  const calls = counted.calls.length;
  const blocked = !isAiPathPermitted(ruleInput);
  if (blocked && calls > 0) {
    throw new Error(`case ${c.id}: controlled medication reached the LLM (${calls} call(s))`);
  }
  const signals = result.status === "ok" ? result.signals : [];
  // Citation validity covers ONLY model-produced signals; tripwire signals are verified by
  // construction and are counted separately.
  const modelSigs = signals.filter((s) => s.origin === "model");
  return {
    ai: toRulesAiResult(result),
    calls,
    modelSignals: modelSigs.length,
    modelSignalsVerified: modelSigs.filter((s) => s.verified).length,
    tripwireSignals: signals.length - modelSigs.length,
    blocked,
    skipped: false,
    obs: {
      status: result.status,
      modelSignals: modelSigs.length,
      tripwireSignals: signals.length - modelSigs.length,
      totalSignals: signals.length,
      injectionHits: detectInjection({
        freeText: c.input.freeText,
        sideEffects: c.input.sideEffects,
      }).length,
      calls,
      blocked,
    },
  };
}
