// Fail-closed wrapper around risk extraction. This is the ONLY entry point the pipeline uses.
//   - controlled / unknown-schedule medication: the LLM is never called (positive allow-list, ai-path-gate.ts)
//   - timeout (AbortSignal), thrown error, malformed JSON, extra fields, unset model/key:
//     result is {status:"failed"}, which rule R13 turns into ESCALATE
//   - every returned signal has been quote-verified; failures are kept (they escalate)
// The result type has no approve field: the LLM can only add escalation signals.
import { FREE_TEXT_MAX } from "@/domain/events";
import { type AiResult, type RuleInput } from "@/domain/rules";
import { isAiPathPermitted } from "./ai-path-gate";
import { createAnthropicClient, type RiskLlmClient } from "./client";
import { loadAiConfig } from "./config";
import { extractRiskSignals } from "./extract-risk-signals";
import { detectInjection } from "./injection";
import { detectTripwire } from "./tripwire";
import { PROMPT_VERSION } from "./prompt";
import { tracerFromEnv, type Tracer } from "./tracing";
import {
  RiskExtractionError,
  SOURCE_FIELDS,
  type FailureReason,
  type RiskTextInput,
} from "./types";
import { verifySignals, type VerifiedSignal } from "./verify-quotes";

export const DEFAULT_TIMEOUT_MS = 15_000;

export type RiskExtractionResult =
  | { status: "ok"; signals: VerifiedSignal[] }
  | {
      status: "failed";
      reason: FailureReason;
      /** Local tripwire signals found even though the model path failed (diagnostic only). */
      localSignals?: VerifiedSignal[];
    };

export interface RunRiskDeps {
  /** null/undefined = no client configured (e.g. no API key): fails closed. */
  client: RiskLlmClient | null | undefined;
  model: string | undefined;
  timeoutMs?: number;
  /** Optional tracer (no-op unless Langfuse env is set; see tracing.ts). */
  tracer?: Tracer;
}

const failed = (reason: FailureReason): RiskExtractionResult => ({ status: "failed", reason });
const failResult = (reason: FailureReason, localSignals: VerifiedSignal[]): RiskExtractionResult =>
  localSignals.length > 0 ? { status: "failed", reason, localSignals } : failed(reason);

function isTextInput(v: unknown): v is RiskTextInput {
  if (typeof v !== "object" || v === null) return false;
  return SOURCE_FIELDS.every((f) => typeof (v as Record<string, unknown>)[f] === "string");
}

/**
 * Runs extraction under a deadline. Never throws, never rejects. Any failure of any kind
 * yields {status:"failed"}.
 */
export async function runRiskExtraction(
  ruleInput: RuleInput,
  text: RiskTextInput,
  deps: RunRiskDeps,
): Promise<RiskExtractionResult> {
  const state = { modelCalled: false };
  const started = Date.now();
  const result = await execute(ruleInput, text, deps, state);
  if (state.modelCalled && deps.tracer) {
    // Tracing is best effort: it can never change or delay-fail the result.
    try {
      await deps.tracer.record({
        name: "extractRiskSignals",
        model: deps.model ?? "unset",
        promptVersion: PROMPT_VERSION,
        latencyMs: Date.now() - started,
        status: result.status,
        ...(result.status === "failed" ? { failureReason: result.reason } : {}),
        signalCount: result.status === "ok" ? result.signals.length : 0,
        unverifiedSignalCount:
          result.status === "ok" ? result.signals.filter((s) => !s.verified).length : 0,
        input: {
          freeTextLength: text.freeText.length,
          sideEffectsLength: text.sideEffects.length,
        },
      });
    } catch {
      /* swallowed */
    }
  }
  return result;
}

async function execute(
  ruleInput: RuleInput,
  text: RiskTextInput,
  deps: RunRiskDeps,
  state: { modelCalled: boolean },
): Promise<RiskExtractionResult> {
  let local: VerifiedSignal[] = [];
  try {
    // 1. POSITIVE allow-list: only a positively identified, allowlisted, non-controlled drug may
    //    reach the LLM. Controlled, unknown, blank, homoglyph or inconsistent medications do not.
    if (!isAiPathPermitted(ruleInput)) return failed("ai_path_blocked");
    if (!isTextInput(text)) return failed("schema_invalid");
    // 2. Bound the work done on patient text before anything else touches it.
    if (text.freeText.length > FREE_TEXT_MAX || text.sideEffects.length > FREE_TEXT_MAX) {
      return failed("input_too_long");
    }
    // 3. Local safety nets run first and regardless of what the model does or whether it runs.
    local = [...detectTripwire(text), ...detectInjection(text)];

    if (!deps.client) return failResult("api_key_missing", local);
    if (!deps.model || deps.model.trim() === "") return failResult("model_not_configured", local);

    // 4. Nothing written by the patient means nothing to extract; no model call needed.
    if (text.freeText.trim() === "" && text.sideEffects.trim() === "") {
      return { status: "ok", signals: [] };
    }

    // 5. Call under a deadline. The race also covers clients that ignore the AbortSignal.
    const controller = new AbortController();
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RiskExtractionError("timeout"));
      }, timeoutMs);
    });
    try {
      state.modelCalled = true;
      const output = await Promise.race([
        extractRiskSignals(text, {
          client: deps.client,
          model: deps.model,
          signal: controller.signal,
        }),
        deadline,
      ]);
      // 6. Server-side quote verification. Nothing is dropped.
      const verified = verifySignals(output.signals, text);
      // 7. Add local signals (deduplicated by span against the model's own).
      const extra = local.filter(
        (l) =>
          !verified.some(
            (v) => v.sourceField === l.sourceField && v.start === l.start && v.end === l.end,
          ),
      );
      return { status: "ok", signals: [...verified, ...extra] };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (e) {
    return failResult(e instanceof RiskExtractionError ? e.reason : "llm_error", local);
  }
}

/** Maps to the rules' AI input type. Failed => {status:"failed"} (R13: LLM_FAILURE => ESCALATE). */
export function toRulesAiResult(r: RiskExtractionResult): AiResult {
  return r.status === "ok" ? { status: "ok", signals: r.signals } : { status: "failed" };
}

/** Builds deps from env: no ANTHROPIC_API_KEY means no client; no ANTHROPIC_MODEL means no model. */
export function riskDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
  timeoutMs?: number,
): RunRiskDeps {
  const cfg = loadAiConfig(env);
  let client: RiskLlmClient | null = null;
  try {
    client = cfg.apiKey ? createAnthropicClient({ apiKey: cfg.apiKey }) : null;
  } catch {
    client = null; // constructor failure => no client => fails closed
  }
  return {
    client,
    model: cfg.model,
    tracer: tracerFromEnv(env),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
