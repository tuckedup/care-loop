import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_DRUGS,
  CONTROLLED_DRUGS,
  FORMULARY,
  findByRxcui,
  getFormularyEntry,
  isAllowlistedRxcui,
} from "./formulary";

describe("formulary", () => {
  it("has exactly the 15 allowlisted drugs from SPEC section 2", () => {
    expect(ALLOWLISTED_DRUGS.map((e) => e.name)).toEqual([
      "fluoxetine",
      "sertraline",
      "escitalopram",
      "citalopram",
      "paroxetine",
      "venlafaxine ER",
      "desvenlafaxine",
      "duloxetine",
      "bupropion SR",
      "bupropion XL",
      "trazodone",
      "mirtazapine",
      "buspirone",
      "hydroxyzine HCl",
      "hydroxyzine pamoate",
    ]);
  });

  it("flags alprazolam and lisdexamfetamine as controlled and not allowlisted", () => {
    expect(CONTROLLED_DRUGS.map((e) => [e.id, e.controlledSchedule, e.allowlisted])).toEqual([
      ["alprazolam", "IV", false],
      ["lisdexamfetamine", "II", false],
    ]);
  });

  it("no allowlisted entry carries a schedule", () => {
    expect(ALLOWLISTED_DRUGS.every((e) => e.controlledSchedule === null)).toBe(true);
  });

  it("every entry has a resolved RxCUI from the cache (or an explicit null)", () => {
    for (const e of FORMULARY) {
      expect(e.rxcui === null || /^\d+$/.test(e.rxcui)).toBe(true);
    }
    expect(FORMULARY.filter((e) => e.rxcui === null).map((e) => e.id)).toEqual([]);
  });

  it.each([
    ["4493", ["fluoxetine"]],
    ["42347", ["bupropion_sr", "bupropion_xl"]],
    ["596", ["alprazolam"]],
    ["700810", ["lisdexamfetamine"]],
  ])("findByRxcui(%s)", (rxcui, ids) => {
    expect(findByRxcui(rxcui).map((e) => e.id)).toEqual(ids);
  });

  it("unknown, null and empty RxCUIs do not match", () => {
    expect(findByRxcui("999999999")).toEqual([]);
    expect(findByRxcui(null)).toEqual([]);
    expect(findByRxcui("")).toEqual([]);
    expect(isAllowlistedRxcui(undefined)).toBe(false);
  });

  it("isAllowlistedRxcui is false for controlled meds", () => {
    expect(isAllowlistedRxcui("596")).toBe(false);
    expect(isAllowlistedRxcui("4493")).toBe(true);
  });

  it("getFormularyEntry", () => {
    expect(getFormularyEntry("trazodone")?.rxcui).toBe("10737");
    expect(getFormularyEntry("nope")).toBeNull();
  });
});
