import { isAllowlistedRxcui } from "../formulary";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/** R01: identity must be verified. Anything other than literal true rejects. */
export function ruleR01(input: RuleInput): RuleEvaluation {
  return input.identityVerified === true
    ? pass("R01", "identity verified")
    : fail("R01", "REJECT", ["IDENTITY_NOT_VERIFIED"], "identity not verified");
}

/**
 * R02: medication must resolve, by RxCUI, to an allowlisted non-controlled formulary entry.
 * The caller-supplied formularyId is not trusted on its own; a missing or unknown RxCUI rejects.
 */
export function ruleR02(input: RuleInput): RuleEvaluation {
  const { rxcui } = input.medication;
  return isAllowlistedRxcui(rxcui)
    ? pass("R02", "medication on formulary allowlist")
    : fail("R02", "REJECT", ["NOT_ON_FORMULARY"], "medication not on formulary allowlist");
}
