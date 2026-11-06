import { phq9Item9 } from "./scoring";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/** Escalate when item 9 >= this value. See ADR-003 in docs/DECISIONS.md. */
export const ITEM9_ESCALATION_THRESHOLD = 1;

/** R07: PHQ-9 item 9 >= 1 escalates. Invalid or missing PHQ-9 data escalates (fail closed). */
export function ruleR07(input: RuleInput): RuleEvaluation {
  const item9 = phq9Item9(input.checkIn?.phq9);
  if (item9 === null) {
    return fail("R07", "ESCALATE", ["INVALID_INPUT"], "PHQ-9 responses missing or invalid");
  }
  return item9 >= ITEM9_ESCALATION_THRESHOLD
    ? fail("R07", "ESCALATE", ["PHQ9_ITEM9_POSITIVE"], `PHQ-9 item 9 = ${item9}`)
    : pass("R07", "PHQ-9 item 9 = 0");
}
