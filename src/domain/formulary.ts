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
}

const ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  ["fluoxetine", "fluoxetine"],
  ["sertraline", "sertraline"],
  ["escitalopram", "escitalopram"],
  ["citalopram", "citalopram"],
  ["paroxetine", "paroxetine"],
  ["venlafaxine_er", "venlafaxine ER"],
  ["desvenlafaxine", "desvenlafaxine"],
  ["duloxetine", "duloxetine"],
  ["bupropion_sr", "bupropion SR"],
  ["bupropion_xl", "bupropion XL"],
  ["trazodone", "trazodone"],
  ["mirtazapine", "mirtazapine"],
  ["buspirone", "buspirone"],
  ["hydroxyzine_hcl", "hydroxyzine HCl"],
  ["hydroxyzine_pamoate", "hydroxyzine pamoate"],
];

const CONTROLLED: ReadonlyArray<readonly [string, string, ControlledSchedule]> = [
  ["alprazolam", "alprazolam", "IV"],
  ["lisdexamfetamine", "lisdexamfetamine", "II"],
];

const rxcuiFor = (id: string): string | null =>
  (cache.entries as Record<string, { rxcui: string | null } | undefined>)[id]?.rxcui ?? null;

export const FORMULARY: readonly FormularyEntry[] = [
  ...ALLOWLIST.map(([id, name]): FormularyEntry => ({
    id,
    name,
    rxcui: rxcuiFor(id),
    allowlisted: true,
    controlledSchedule: null,
  })),
  ...CONTROLLED.map(([id, name, controlledSchedule]): FormularyEntry => ({
    id,
    name,
    rxcui: rxcuiFor(id),
    allowlisted: false,
    controlledSchedule,
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
