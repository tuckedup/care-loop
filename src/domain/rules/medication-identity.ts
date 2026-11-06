// M01 medication identity consistency and M02 dose form. Both fail closed (ESCALATE).
// The RxCUI is the anchor; the name text and formularyId must agree with it.
import {
  entriesNamedIn,
  findByRxcui,
  formTokensIn,
  getFormularyEntry,
  type FormularyEntry,
} from "../formulary";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/**
 * M01: the name, formularyId and RxCUI must all identify the same drug. Any conflict (name names
 * a different drug, name names no recognised drug for the RxCUI, formularyId unknown or for a
 * different RxCUI) escalates. A null RxCUI is left to R02 (REJECT).
 */
export function ruleM01(input: RuleInput): RuleEvaluation {
  const med = input.medication;
  const rxcui = med.rxcui;
  if (!rxcui) return pass("M01", "no RxCUI to cross-check (R02 handles)");

  const expected = findByRxcui(rxcui);
  if (expected.length === 0) return pass("M01", "RxCUI unknown to formulary (R02 rejects)");
  const expectedAliases = new Set(expected.flatMap((e) => e.aliases));
  const named = entriesNamedIn(med.name);
  const namedElsewhere = named.filter((e) => !e.aliases.some((a) => expectedAliases.has(a)));
  const namesExpected = named.some((e) => e.aliases.some((a) => expectedAliases.has(a)));

  const problems: string[] = [];
  if (namedElsewhere.length > 0) problems.push("name identifies a different drug than the RxCUI");
  if (!namesExpected) problems.push("name not recognised as the drug the RxCUI maps to");
  if (med.formularyId !== null && med.formularyId !== undefined) {
    const entry = getFormularyEntry(med.formularyId);
    if (!entry || entry.rxcui !== rxcui) problems.push("formularyId conflicts with RxCUI");
  }
  return problems.length === 0
    ? pass("M01", "name, formulary id and RxCUI agree")
    : fail("M01", "ESCALATE", ["MEDICATION_IDENTITY_MISMATCH"], problems.join("; "));
}

/**
 * M02: dose form. Form-specific entries (bupropion SR/XL, venlafaxine ER) need an allowed form
 * word in the medication text; any other recognised form word (IR, immediate release, CR, ...)
 * escalates. Non-form-specific entries accept no form word. Ingredient-level RxCUIs cannot tell
 * forms apart, so this text check is the only safeguard (see ADR-003 note).
 */
export function ruleM02(input: RuleInput): RuleEvaluation {
  const med = input.medication;
  const candidates: readonly FormularyEntry[] =
    med.formularyId !== null && med.formularyId !== undefined
      ? [getFormularyEntry(med.formularyId)].filter((e): e is FormularyEntry => e !== null)
      : findByRxcui(med.rxcui);
  const allowedEntries = candidates.filter((e) => e.allowlisted);
  if (allowedEntries.length === 0) return pass("M02", "no allowlisted entry, check not applicable");

  const allowed = new Set(allowedEntries.flatMap((e) => e.formTokens));
  const present = formTokensIn(med.name);
  const formSpecific = allowed.size > 0;
  const stray = present.filter((t) => !allowed.has(t));

  if (stray.length > 0) {
    return fail(
      "M02",
      "ESCALATE",
      ["DOSE_FORM_NOT_ALLOWLISTED"],
      `dose form "${stray.join(", ")}" is not the allowlisted form`,
    );
  }
  if (formSpecific && present.length === 0) {
    return fail(
      "M02",
      "ESCALATE",
      ["DOSE_FORM_NOT_ALLOWLISTED"],
      "dose form missing for a form-specific formulary entry",
    );
  }
  return pass("M02", "dose form consistent with the allowlist entry");
}
