import { scorePhq9 } from "./scoring";
import { fail, pass, type ReasonCode, type RuleEvaluation, type RuleInput } from "./types";

export const PHQ9_TOTAL_ESCALATION = 15;
export const PHQ9_RISE_ESCALATION = 5;

/**
 * R08: PHQ-9 total >= 15, or a rise of >= 5 from the last recorded total, escalates.
 * With no prior score (null) only the absolute rule applies. Invalid current responses or an
 * invalid (non-null) prior total escalate (fail closed).
 */
export function ruleR08(input: RuleInput): RuleEvaluation {
  const total = scorePhq9(input.checkIn?.phq9);
  if (total === null) {
    return fail("R08", "ESCALATE", ["INVALID_INPUT"], "PHQ-9 responses missing or invalid");
  }
  const prior = input.priorPhq9Total;
  if (prior !== null && (!Number.isInteger(prior) || prior < 0 || prior > 27)) {
    return fail("R08", "ESCALATE", ["INVALID_INPUT"], "prior PHQ-9 total missing or invalid");
  }

  const reasons: ReasonCode[] = [];
  const notes: string[] = [];
  if (total >= PHQ9_TOTAL_ESCALATION) {
    reasons.push("PHQ9_TOTAL_HIGH");
    notes.push(`total ${total} >= ${PHQ9_TOTAL_ESCALATION}`);
  }
  if (prior !== null && total - prior >= PHQ9_RISE_ESCALATION) {
    reasons.push("PHQ9_RISE");
    notes.push(`rise ${total - prior} from prior ${prior} >= ${PHQ9_RISE_ESCALATION}`);
  }
  return reasons.length > 0
    ? fail("R08", "ESCALATE", reasons, notes.join("; "))
    : pass(
        "R08",
        `PHQ-9 total ${total}${prior === null ? ", no prior score" : `, prior ${prior}`}`,
      );
}
