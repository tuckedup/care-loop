// Server-side quote verification (SPEC section 5). Offsets are UTF-16 code units, i.e. the
// semantics of String.prototype.slice, over the exact text the patient submitted.
// A signal that fails verification is KEPT and still counts as an escalation signal: it is
// never dropped, never "repaired", and never trusted as evidence.
import type { RiskSignal, RiskTextInput } from "./types";

export type QuoteProblem = "unknown_field" | "out_of_range" | "quote_mismatch";

export interface VerifiedSignal extends RiskSignal {
  /** "model" = produced by the LLM; "tripwire" = produced locally (verified by construction). */
  origin: "model" | "tripwire";
  /** true only if the text at [start,end) of sourceField equals quote exactly. */
  verified: boolean;
  problem?: QuoteProblem;
}

export function verifySignal(signal: RiskSignal, input: RiskTextInput): VerifiedSignal {
  const text: unknown = Object.prototype.hasOwnProperty.call(input, signal.sourceField)
    ? input[signal.sourceField]
    : undefined;
  if (typeof text !== "string") {
    return { ...signal, origin: "model", verified: false, problem: "unknown_field" };
  }
  if (
    !Number.isInteger(signal.start) ||
    !Number.isInteger(signal.end) ||
    signal.start < 0 ||
    signal.end <= signal.start ||
    signal.end > text.length
  ) {
    return { ...signal, origin: "model", verified: false, problem: "out_of_range" };
  }
  return text.slice(signal.start, signal.end) === signal.quote
    ? { ...signal, origin: "model", verified: true }
    : { ...signal, origin: "model", verified: false, problem: "quote_mismatch" };
}

/** Verifies every signal. Output length always equals input length (nothing is dropped). */
export function verifySignals(
  signals: readonly RiskSignal[],
  input: RiskTextInput,
): VerifiedSignal[] {
  return signals.map((s) => verifySignal(s, input));
}
