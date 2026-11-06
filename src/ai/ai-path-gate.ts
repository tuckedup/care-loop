// POSITIVE allow-list for the AI path. isAiPathAllowed (rules) only blocks drugs it recognises
// as controlled, so on its own it lets unknown / homoglyph / blank medications through. The AI
// path therefore additionally requires that the medication positively resolves to an allowlisted,
// non-controlled formulary entry. The checks are the rules' own (R02, M01, M02), reused, not
// re-implemented, so the AI gate cannot drift from the rule engine.
import { isAiPathAllowed, type RuleInput } from "@/domain/rules";
import { ruleM01, ruleM02 } from "@/domain/rules/medication-identity";
import { ruleR02 } from "@/domain/rules/r01-r02";
import { findByRxcui, getFormularyEntry } from "@/domain/formulary";

/** True only if the medication is positively identified as an allowlisted, non-controlled drug. */
export function isAiPathPermitted(input: RuleInput): boolean {
  try {
    if (!isAiPathAllowed(input)) return false;
    const med = input.medication;
    if (!med || typeof med.rxcui !== "string" || med.rxcui === "") return false;
    const entries = findByRxcui(med.rxcui);
    if (entries.length === 0) return false;
    if (entries.some((e) => e.controlledSchedule !== null)) return false;
    if (!entries.some((e) => e.allowlisted)) return false;
    if (med.formularyId !== null && med.formularyId !== undefined) {
      const f = getFormularyEntry(med.formularyId);
      if (!f || !f.allowlisted || f.controlledSchedule !== null || f.rxcui !== med.rxcui) {
        return false;
      }
    }
    return ruleR02(input).passed && ruleM01(input).passed && ruleM02(input).passed;
  } catch {
    return false;
  }
}
