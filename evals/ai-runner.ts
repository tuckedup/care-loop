// Runs the AI stage of the pipeline for one eval case, using a fixture-backed (recorded-style)
// client by default or the live Anthropic client when EVAL_LIVE=1. The live path is implemented
// but was NOT exercised in this repo (no API key was available).
import { createAnthropicClient, createRecordedClient, type RiskLlmClient } from "../src/ai/client";
import { loadAiConfig } from "../src/ai/config";
import { runRiskExtraction, toRulesAiResult } from "../src/ai/fail-closed";
import { isAiPathAllowed } from "../src/domain/rules";
import { loadFixture } from "./fixtures";
import { toRuleInput, type AiForRules } from "./lib";
import type { EvalCase } from "./schema";

export interface AiStageResult {
  ai: AiForRules;
  /** Model calls made. Must be 0 for controlled medications. */
  calls: number;
  signalsTotal: number;
  signalsVerified: number;
  expectsValidCitations: boolean;
  /** Excluded from this run (fixture-only case during a live run). */
  skipped: boolean;
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
      signalsTotal: 0,
      signalsVerified: 0,
      expectsValidCitations: true,
      skipped: true,
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
  if (!isAiPathAllowed(ruleInput) && calls > 0) {
    throw new Error(`case ${c.id}: controlled medication reached the LLM (${calls} call(s))`);
  }
  const signals = result.status === "ok" ? result.signals : [];
  // Counts every returned signal; local tripwire signals are verified by construction.
  return {
    ai: toRulesAiResult(result),
    calls,
    signalsTotal: signals.length,
    signalsVerified: signals.filter((s) => s.verified).length,
    expectsValidCitations: fixture.header.expectsValidCitations,
    skipped: false,
  };
}
