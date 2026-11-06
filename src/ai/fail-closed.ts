// Fail-closed wrapper around risk extraction. This is the ONLY entry point the pipeline uses.
//   - controlled / unknown-schedule medication: the LLM is never called (isAiPathAllowed)
//   - timeout (AbortSignal), thrown error, malformed JSON, extra fields, unset model/key:
//     result is {status:"failed"}, which rule R13 turns into ESCALATE
//   - every returned signal has been quote-verified; failures are kept (they escalate)
// The result type has no approve field: the LLM can only add escalation signals.
import { isAiPathAllowed, type AiResult, type RuleInput } from "@/domain/rules";
import { createAnthropicClient, type RiskLlmClient } from "./client";
import { loadAiConfig } from "./config";
import { extractRiskSignals } from "./extract-risk-signals";
import { detectInjection } from "./injection";
import {
  RiskExtractionError,
  SOURCE_FIELDS,
  type FailureReason,
  type RiskTextInput,
} from "./types";
import { verifySignals, type VerifiedSignal } from "./verify-quotes";

export const DEFAULT_TIMEOUT_MS = 15_000;

export type RiskExtractionResult =
  { status: "ok"; signals: VerifiedSignal[] } | { status: "failed"; reason: FailureReason };

export interface RunRiskDeps {
  /** null/undefined = no client configured (e.g. no API key): fails closed. */
  client: RiskLlmClient | null | undefined;
  model: string | undefined;
  timeoutMs?: number;
}

const failed = (reason: FailureReason): RiskExtractionResult => ({ status: "failed", reason });

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
  try {
    // 1. Controlled substances (or unknown schedule) never reach the LLM.
    if (!isAiPathAllowed(ruleInput)) return failed("ai_path_blocked");
    if (!isTextInput(text)) return failed("schema_invalid");
    if (!deps.client) return failed("api_key_missing");
    if (!deps.model || deps.model.trim() === "") return failed("model_not_configured");

    // 2. Nothing written by the patient means nothing to extract; no model call needed.
    if (text.freeText.trim() === "" && text.sideEffects.trim() === "") {
      return { status: "ok", signals: [] };
    }

    // 3. Call under a deadline. The race also covers clients that ignore the AbortSignal.
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
      const output = await Promise.race([
        extractRiskSignals(text, {
          client: deps.client,
          model: deps.model,
          signal: controller.signal,
        }),
        deadline,
      ]);
      // 4. Server-side quote verification. Nothing is dropped.
      const verified = verifySignals(output.signals, text);
      // 5. Local injection tripwire: adds signals even if the model was fooled into silence.
      const local = detectInjection(text).filter(
        (l) =>
          !verified.some(
            (v) => v.sourceField === l.sourceField && v.start === l.start && v.end === l.end,
          ),
      );
      return { status: "ok", signals: [...verified, ...local] };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (e) {
    return failed(e instanceof RiskExtractionError ? e.reason : "llm_error");
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
  return {
    client: cfg.apiKey ? createAnthropicClient({ apiKey: cfg.apiKey }) : null,
    model: cfg.model,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
