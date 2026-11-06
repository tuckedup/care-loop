// evaluateEligibility: runs every rule in a fixed order and aggregates deterministically.
// Pure: no I/O, no clock, no randomness, no env. Config (refillLimit) arrives in the input.
import { ruleD01Trazodone, ruleD02Mirtazapine, ruleD03Hydroxyzine } from "./drug-specific";
import { ruleR01, ruleR02 } from "./r01-r02";
import { isControlled, ruleR03 } from "./r03-controlled";
import { ruleR04, ruleR05 } from "./r04-r05";
import { ruleR06 } from "./r06-refill-limit";
import { ruleR07 } from "./r07-item9";
import { ruleR08 } from "./r08-phq9-total";
import { ruleR09, ruleR10, ruleR11, ruleR12 } from "./r09-r12-structured";
import { ruleR13 } from "./r13-ai-signal";
import { scoreGad7 } from "./scoring";
import {
  fail,
  pass,
  type Outcome,
  type ReasonCode,
  type RuleEvaluation,
  type RuleId,
  type RuleInput,
  type RuleResult,
} from "./types";

/** R00: input integrity for fields no other rule scores (GAD-7). Malformed data escalates. */
export function ruleR00(input: RuleInput): RuleEvaluation {
  return scoreGad7(input.checkIn?.gad7) === null
    ? fail("R00", "ESCALATE", ["INVALID_INPUT"], "GAD-7 responses missing or invalid")
    : pass("R00", "check-in responses well formed");
}

/** Fixed evaluation order. Every rule always runs so the audit trail is complete. */
export const RULE_ORDER: ReadonlyArray<readonly [RuleId, (i: RuleInput) => RuleEvaluation]> = [
  ["R01", ruleR01],
  ["R02", ruleR02],
  ["R03", ruleR03],
  ["R04", ruleR04],
  ["R05", ruleR05],
  ["R06", ruleR06],
  ["R07", ruleR07],
  ["R08", ruleR08],
  ["R09", ruleR09],
  ["R10", ruleR10],
  ["R11", ruleR11],
  ["R12", ruleR12],
  ["R13", ruleR13],
  ["D01", ruleD01Trazodone],
  ["D02", ruleD02Mirtazapine],
  ["D03", ruleD03Hydroxyzine],
  ["R00", ruleR00],
];

export interface EligibilityResult {
  outcome: Outcome;
  /** Persistable shape for EligibilityEvaluated.results. */
  results: RuleResult[];
  /** Unique reason codes of every failed rule, in rule order. */
  reasonCodes: ReasonCode[];
}

function runSafely(id: RuleId, rule: (i: RuleInput) => RuleEvaluation, input: RuleInput) {
  try {
    return rule(input);
  } catch {
    // A rule that cannot evaluate its input must not let the request through.
    return fail(id, "ESCALATE", ["INVALID_INPUT"], "rule could not evaluate input (fail closed)");
  }
}

/**
 * Precedence: REJECT > ESCALATE > FOLLOW_UP_REQUIRED > AUTO_ELIGIBLE.
 * ESCALATE outranks FOLLOW_UP_REQUIRED so a clinician sees any safety signal even when the
 * refill limit is also hit; the escalate reasons then include REFILL_LIMIT_REACHED.
 * AUTO_ELIGIBLE requires every rule to pass and the medication to be non-controlled.
 */
export function evaluateEligibility(input: RuleInput): EligibilityResult {
  const evals = RULE_ORDER.map(([id, rule]) => runSafely(id, rule, input));
  const failed = evals.filter((e) => !e.passed);
  const reasonCodes = [...new Set(failed.flatMap((e) => e.reasonCodes))];
  const results: RuleResult[] = evals.map(({ ruleId, passed, detail }) => ({
    ruleId,
    passed,
    detail,
  }));

  const firstOf = (effect: RuleEvaluation["effect"]) =>
    failed.find((e) => e.effect === effect)?.reasonCodes[0] ?? "INVALID_INPUT";

  let outcome: Outcome;
  if (failed.some((e) => e.effect === "REJECT")) {
    outcome = { type: "REJECT", reason: firstOf("REJECT") };
  } else if (failed.some((e) => e.effect === "ESCALATE")) {
    outcome = { type: "ESCALATE", reasons: reasonCodes };
  } else if (failed.some((e) => e.effect === "FOLLOW_UP_REQUIRED")) {
    outcome = { type: "FOLLOW_UP_REQUIRED", reason: firstOf("FOLLOW_UP_REQUIRED") };
  } else if (failed.length > 0 || evals.length !== RULE_ORDER.length) {
    outcome = { type: "ESCALATE", reasons: reasonCodes.length ? reasonCodes : ["INVALID_INPUT"] };
  } else if (isControlled(input)) {
    // Defence in depth: controlled meds can never be AUTO_ELIGIBLE.
    outcome = { type: "ESCALATE", reasons: ["CONTROLLED_SUBSTANCE"] };
  } else {
    outcome = { type: "AUTO_ELIGIBLE" };
  }
  return { outcome, results, reasonCodes };
}
