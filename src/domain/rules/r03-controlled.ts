import { findByRxcui, getFormularyEntry } from "../formulary";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/**
 * True when ANY signal says the medication is controlled, or the schedule is unknown.
 * Signals: the input's schedule flag (anything but null, including undefined), the formulary
 * entry resolved from the RxCUI, and the formulary entry named by formularyId.
 */
export function isControlled(input: RuleInput): boolean {
  const med = input.medication;
  if (med?.controlledSchedule !== null) return true;
  if (findByRxcui(med.rxcui).some((e) => e.controlledSchedule !== null)) return true;
  if (med.formularyId !== null && med.formularyId !== undefined) {
    if (getFormularyEntry(med.formularyId)?.controlledSchedule) return true;
  }
  return false;
}

/**
 * Gate for the AI path. Controlled substances (or an unknown schedule) must never be sent to
 * the LLM. Callers must check this before any AI call.
 */
export function isAiPathAllowed(input: RuleInput): boolean {
  return !isControlled(input);
}

/** R03: controlled substance is a hard block. It can never yield AUTO_ELIGIBLE. */
export function ruleR03(input: RuleInput): RuleEvaluation {
  return isControlled(input)
    ? fail(
        "R03",
        "ESCALATE",
        ["CONTROLLED_SUBSTANCE"],
        "controlled substance (or unknown schedule): hard block, excluded from the AI path",
      )
    : pass("R03", "not a controlled substance");
}
