import { isControlled } from "./r03-controlled";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/**
 * R13: any LLM risk signal, LLM failure, invalid output, or an ABSENT AI result escalates.
 * The LLM can only add escalation signals; an empty signal list never overrides another rule.
 * Controlled substances never enter the AI path, so input.ai is not even read for them.
 */
export function ruleR13(input: RuleInput): RuleEvaluation {
  if (isControlled(input)) {
    return pass("R13", "not evaluated: controlled substances never enter the AI path");
  }
  const ai = input.ai;
  if (ai === undefined || ai === null) {
    return fail("R13", "ESCALATE", ["LLM_FAILURE"], "no AI result available (fail closed)");
  }
  if (ai.status === "failed") {
    return fail("R13", "ESCALATE", ["LLM_FAILURE"], "AI extraction failed (fail closed)");
  }
  if (ai.status !== "ok" || !Array.isArray(ai.signals)) {
    return fail("R13", "ESCALATE", ["LLM_FAILURE"], "AI result malformed (fail closed)");
  }
  return ai.signals.length > 0
    ? fail("R13", "ESCALATE", ["LLM_RISK_SIGNAL"], `${ai.signals.length} AI risk signal(s)`)
    : pass("R13", "AI extraction ok, no risk signals");
}
