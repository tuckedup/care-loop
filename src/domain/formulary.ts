// Pure formulary reference data. No I/O: the RxCUI cache is bundled JSON.
// The 15-drug allowlist comes from docs/SPEC.md section 2 (signed Utah Legion agreement).
// Controlled entries exist only so tests can prove they are blocked; they are NOT allowlisted.
import cache from "../../data/rxnorm-cache.json";

export type ControlledSchedule = "II" | "III" | "IV" | "V";

export interface FormularyEntry {
  readonly id: string;
  readonly name: string;
  /** RxNorm RxCUI from the cached RxNav lookup; null = unresolved (TODO, never invented). */
  readonly rxcui: string | null;
  readonly allowlisted: boolean;
  /** Federal schedule for controlled meds, otherwise null. */
  readonly controlledSchedule: ControlledSchedule | null;
  /** Normalised (lowercase, alphanumeric words) names that identify this drug in free text. */
  readonly aliases: readonly string[];
  /**
   * Dose-form words that match this allowlist entry (e.g. "sr"). Empty = the entry is not
   * form-specific, so no modified-release/immediate-release wording is accepted for it.
   */
  readonly formTokens: readonly string[];
}

// [id, display name, aliases, formTokens]
const ALLOWLIST: ReadonlyArray<readonly [string, string, string[], string[]]> = [
  ["fluoxetine", "fluoxetine", ["fluoxetine"], []],
  ["sertraline", "sertraline", ["sertraline"], []],
  ["escitalopram", "escitalopram", ["escitalopram"], []],
  ["citalopram", "citalopram", ["citalopram"], []],
  ["paroxetine", "paroxetine", ["paroxetine"], []],
  ["venlafaxine_er", "venlafaxine ER", ["venlafaxine"], ["er", "extended release"]],
  ["desvenlafaxine", "desvenlafaxine", ["desvenlafaxine"], []],
  ["duloxetine", "duloxetine", ["duloxetine"], []],
  ["bupropion_sr", "bupropion SR", ["bupropion"], ["sr", "sustained release"]],
  ["bupropion_xl", "bupropion XL", ["bupropion"], ["xl", "extended release"]],
  ["trazodone", "trazodone", ["trazodone"], []],
  ["mirtazapine", "mirtazapine", ["mirtazapine"], []],
  ["buspirone", "buspirone", ["buspirone"], []],
  ["hydroxyzine_hcl", "hydroxyzine HCl", ["hydroxyzine"], []],
  ["hydroxyzine_pamoate", "hydroxyzine pamoate", ["hydroxyzine"], []],
];

// [id, display name, schedule, aliases (generic + obvious brand)]
const CONTROLLED: ReadonlyArray<readonly [string, string, ControlledSchedule, string[]]> = [
  ["alprazolam", "alprazolam", "IV", ["alprazolam", "xanax"]],
  ["lisdexamfetamine", "lisdexamfetamine", "II", ["lisdexamfetamine", "vyvanse"]],
];

/** Dose-form words that are recognised in medication text (normalised). */
export const KNOWN_FORM_TOKENS: readonly string[] = [
  "ir",
  "immediate release",
  "er",
  "xr",
  "xl",
  "sr",
  "cr",
  "la",
  "dr",
  "extended release",
  "sustained release",
  "delayed release",
  "controlled release",
  "long acting",
];

const rxcuiFor = (id: string): string | null =>
  (cache.entries as Record<string, { rxcui: string | null } | undefined>)[id]?.rxcui ?? null;

export const FORMULARY: readonly FormularyEntry[] = [
  ...ALLOWLIST.map(([id, name, aliases, formTokens]): FormularyEntry => ({
    id,
    name,
    rxcui: rxcuiFor(id),
    allowlisted: true,
    controlledSchedule: null,
    aliases,
    formTokens,
  })),
  ...CONTROLLED.map(([id, name, controlledSchedule, aliases]): FormularyEntry => ({
    id,
    name,
    rxcui: rxcuiFor(id),
    allowlisted: false,
    controlledSchedule,
    aliases,
    formTokens: [],
  })),
];

export const ALLOWLISTED_DRUGS: readonly FormularyEntry[] = FORMULARY.filter((e) => e.allowlisted);
export const CONTROLLED_DRUGS: readonly FormularyEntry[] = FORMULARY.filter(
  (e) => e.controlledSchedule !== null,
);

export function getFormularyEntry(id: string): FormularyEntry | null {
  return FORMULARY.find((e) => e.id === id) ?? null;
}

/**
 * All entries sharing an RxCUI. Release forms (bupropion SR/XL) share an ingredient RxCUI,
 * so this returns a list. Null/empty input never matches (fail closed).
 */
export function findByRxcui(rxcui: string | null | undefined): readonly FormularyEntry[] {
  if (!rxcui) return [];
  return FORMULARY.filter((e) => e.rxcui === rxcui);
}

/** True when the RxCUI resolves to at least one allowlisted, non-controlled entry. */
export function isAllowlistedRxcui(rxcui: string | null | undefined): boolean {
  return findByRxcui(rxcui).some((e) => e.allowlisted && e.controlledSchedule === null);
}

/** Lowercase, punctuation to single spaces, trimmed. "Extended-Release" -> "extended release". */
export function normalizeMedText(text: unknown): string {
  return canonicalizeMedText(text).text;
}

/**
 * Canonical form of free medication text: NFKC, zero-width/format characters removed,
 * diacritics stripped, lowercased, every non-[a-z0-9] run collapsed to one space.
 * `nonAscii` is true when any non-ASCII character survives normalisation (e.g. Cyrillic
 * homoglyphs), which callers must treat as suspicious. Non-strings give { "", true }.
 */
export function canonicalizeMedText(text: unknown): { text: string; nonAscii: boolean } {
  if (typeof text !== "string") return { text: "", nonAscii: true };
  const folded = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  return {
    nonAscii: /[^\x00-\x7f]/.test(folded),
    text: folded.replace(/[^a-z0-9]+/g, " ").trim(),
  };
}

/** True if `alias` occurs in the text, also when letters were split by spaces ("alpra zolam"). */
export function textMentions(text: unknown, alias: string): boolean {
  const spaced = normalizeMedText(text);
  return spaced.includes(alias) || spaced.replace(/ /g, "").includes(alias);
}

/**
 * Entries (any, incl. controlled) whose aliases appear in the medication text. An alias that
 * only occurs inside a longer matched alias is ignored ("citalopram" inside "escitalopram").
 */
export function entriesNamedIn(text: unknown): readonly FormularyEntry[] {
  const allAliases = [...new Set(FORMULARY.flatMap((e) => e.aliases))];
  const mentioned = allAliases.filter((a) => textMentions(text, a));
  const effective = new Set(
    mentioned.filter((a) => !mentioned.some((b) => b !== a && b.includes(a))),
  );
  return FORMULARY.filter((e) => e.aliases.some((a) => effective.has(a)));
}

/** Recognised dose-form words present in the text, as whole words/phrases. */
export function formTokensIn(text: unknown): readonly string[] {
  const padded = ` ${normalizeMedText(text)} `;
  return KNOWN_FORM_TOKENS.filter((t) => padded.includes(` ${t} `));
}
