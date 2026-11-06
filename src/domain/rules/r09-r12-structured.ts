import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

// Fail closed throughout: only the exact "safe" value passes. Missing/unrecognised values escalate.

/** R09: pregnancy "yes" or "unsure" (or any value other than "no") escalates. */
export function ruleR09(input: RuleInput): RuleEvaluation {
  const v = input.checkIn?.pregnancy;
  return v === "no"
    ? pass("R09", "pregnancy answered no")
    : fail("R09", "ESCALATE", ["PREGNANCY_YES_OR_UNSURE"], `pregnancy answer: ${String(v)}`);
}

/** R10: a reported severe side effect escalates. Only literal false passes. */
export function ruleR10(input: RuleInput): RuleEvaluation {
  const v = input.checkIn?.severeSideEffect;
  return v === false
    ? pass("R10", "no severe side effect reported")
    : fail("R10", "ESCALATE", ["SEVERE_SIDE_EFFECT"], `severe side effect flag: ${String(v)}`);
}

/** R11: a positive mania screen escalates. Only literal false passes. */
export function ruleR11(input: RuleInput): RuleEvaluation {
  const v = input.checkIn?.maniaScreen;
  return v === false
    ? pass("R11", "mania screen negative")
    : fail("R11", "ESCALATE", ["MANIA_SCREEN_POSITIVE"], `mania screen positive: ${String(v)}`);
}

/** R12: a patient request for a human escalates. Only literal false passes. */
export function ruleR12(input: RuleInput): RuleEvaluation {
  const v = input.checkIn?.requestedHuman;
  return v === false
    ? pass("R12", "patient did not request a human")
    : fail("R12", "ESCALATE", ["PATIENT_REQUESTED_HUMAN"], `human requested: ${String(v)}`);
}
