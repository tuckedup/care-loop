// M01 medication identity consistency and M02 dose form. Both fail closed (ESCALATE).
// The RxCUI is the anchor; the name text and formularyId must agree with it.
import {
  canonicalizeMedText,
  findByRxcui,
  formTokensIn,
  getFormularyEntry,
  KNOWN_FORM_TOKENS,
  type FormularyEntry,
} from "../formulary";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/**
 * Words that may accompany the drug name without raising suspicion: units, dosage-form nouns,
 * salts and the dose-form words M02 understands. This is a deliberately SMALL allow-vocabulary,
 * not a drug list. Anything else in the name text is unexplained and escalates.
 */
const BENIGN_WORDS: ReadonlySet<string> = new Set([
  "mg",
  "mcg",
  "g",
  "ml",
  "tablet",
  "tablets",
  "tab",
  "tabs",
  "capsule",
  "capsules",
  "cap",
  "caps",
  "hcl",
  "hydrochloride",
  "pamoate",
  "oral",
  "extended",
  "release",
  ...KNOWN_FORM_TOKENS.flatMap((t) => t.split(" ")),
]);

/** A number, optionally glued to a unit ("20", "20mg", "37 5" after punctuation folding). */
const DOSE_TOKEN = /^\d+(mg|mcg|g|ml)?$/;

const isBenign = (token: string): boolean => DOSE_TOKEN.test(token) || BENIGN_WORDS.has(token);

/**
 * M01: the name, formularyId and RxCUI must all identify the same drug.
 * The name is checked by inversion: remove the expected drug's own aliases, then every remaining
 * word must be benign (digits, units, dosage-form words). Any unexplained word (another drug,
 * a typo, a brand), any non-ASCII character left after normalisation (homoglyphs), a name that
 * does not contain the expected drug, or a formularyId for a different RxCUI escalates.
 * Over-escalation is intended. A null/unknown RxCUI is left to R02 (REJECT).
 */
export function ruleM01(input: RuleInput): RuleEvaluation {
  const med = input.medication;
  const rxcui = med.rxcui;
  if (!rxcui) return pass("M01", "no RxCUI to cross-check (R02 handles)");

  const expected = findByRxcui(rxcui);
  if (expected.length === 0) return pass("M01", "RxCUI unknown to formulary (R02 rejects)");

  const problems: string[] = [];
  const { text, nonAscii } = canonicalizeMedText(med.name);
  if (nonAscii) problems.push("name has non-ASCII characters after normalisation");

  const aliases = [...new Set(expected.flatMap((e) => e.aliases))].sort(
    (a, b) => b.length - a.length,
  );
  let rest = ` ${text} `;
  let found = false;
  for (const alias of aliases) {
    // Whole-word match only: "citalopram" must not be carved out of "escitalopram".
    const re = new RegExp(` ${alias} `);
    while (re.test(rest)) {
      found = true;
      rest = rest.replace(re, " ");
    }
  }
  if (!found) problems.push("name does not contain the drug the RxCUI maps to");
  const unexplained = rest.split(" ").filter((t) => t !== "" && !isBenign(t));
  if (unexplained.length > 0) problems.push("name has unexplained words");

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
