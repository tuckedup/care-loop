// Types and Zod schemas for the AI risk-extraction path.
// The model output type deliberately has NO approve / decision / outcome field: the LLM can only
// ADD escalation signals. Unknown keys are rejected (.strict()), so a model that emits
// {"approve": true} produces a schema-invalid result, which fails closed.
import { z } from "zod";

/** Patient-authored text fields the model may quote from. */
export const SOURCE_FIELDS = ["freeText", "sideEffects"] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];

/**
 * Signal categories. They mirror the structured escalation triggers in SPEC section 4
 * (R05, R07, R09, R10, R11, R12) plus a catch-all. No clinical thresholds live here.
 */
export const SIGNAL_TYPES = [
  "suicidal_ideation",
  "self_harm",
  "harm_to_others",
  "pregnancy_mention",
  "mania_symptoms",
  "severe_side_effect",
  "dose_or_drug_change_request",
  "substance_misuse",
  "request_for_human",
  "prompt_injection_attempt",
  "other_safety_concern",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const MAX_SIGNALS = 20;
export const MAX_QUOTE_LENGTH = 500;

export const RiskSignalSchema = z
  .object({
    type: z.enum(SIGNAL_TYPES),
    quote: z.string().min(1).max(MAX_QUOTE_LENGTH),
    sourceField: z.enum(SOURCE_FIELDS),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .strict()
  .refine((s) => s.end > s.start, { message: "end must be greater than start" });

/** The ONLY shape accepted from the model. */
export const RiskOutputSchema = z
  .object({ signals: z.array(RiskSignalSchema).max(MAX_SIGNALS) })
  .strict();

export type RiskSignal = z.infer<typeof RiskSignalSchema>;
export type RiskOutput = z.infer<typeof RiskOutputSchema>;

/** Patient text handed to extraction. Everything in here is untrusted DATA. */
export interface RiskTextInput {
  freeText: string;
  sideEffects: string;
}

export type FailureReason =
  | "ai_path_blocked"
  | "model_not_configured"
  | "api_key_missing"
  | "timeout"
  | "llm_error"
  | "malformed_json"
  | "schema_invalid"
  | "prompt_error";

/** Thrown by the low-level call; the fail-closed wrapper turns it into {status:"failed"}. */
export class RiskExtractionError extends Error {
  constructor(
    readonly reason: FailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "RiskExtractionError";
  }
}
