import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * R06: renewals since the last visit must be strictly below the configured limit, otherwise a
 * follow-up visit is required. The limit is config passed in via input.refillLimit (default 2 is
 * applied by the caller's config layer, never here). Invalid counts escalate (fail closed).
 */
export function ruleR06(input: RuleInput): RuleEvaluation {
  const { renewalsSinceLastVisit: renewals, refillLimit: limit } = input;
  if (!isCount(renewals) || !isCount(limit)) {
    return fail(
      "R06",
      "ESCALATE",
      ["INVALID_INPUT"],
      "renewal count or refill limit missing or not a non-negative integer",
    );
  }
  return renewals < limit
    ? pass("R06", `${renewals} renewals since last visit, below limit ${limit}`)
    : fail(
        "R06",
        "FOLLOW_UP_REQUIRED",
        ["REFILL_LIMIT_REACHED"],
        `${renewals} renewals since last visit reaches limit ${limit}`,
      );
}
