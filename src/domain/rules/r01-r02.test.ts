import { describe, expect, it } from "vitest";
import { ALLOWLISTED_DRUGS, CONTROLLED_DRUGS } from "../formulary";
import { baseInput } from "./fixtures";
import { ruleR01, ruleR02 } from "./r01-r02";

describe("R01 identity verified", () => {
  it("passes when verified", () => {
    const r = ruleR01(baseInput({ identityVerified: true }));
    expect(r).toMatchObject({ ruleId: "R01", passed: true, effect: null, reasonCodes: [] });
  });
  it.each([false, undefined, null, "true", 1] as unknown[])("rejects for %j", (v) => {
    const r = ruleR01(baseInput({ identityVerified: v as boolean }));
    expect(r).toMatchObject({
      passed: false,
      effect: "REJECT",
      reasonCodes: ["IDENTITY_NOT_VERIFIED"],
    });
  });
});

describe("R02 formulary allowlist", () => {
  it.each(ALLOWLISTED_DRUGS.map((d) => [d.name, d.rxcui] as const))("allows %s", (name, rxcui) => {
    const input = baseInput();
    input.medication = { ...input.medication, name, rxcui };
    expect(ruleR02(input)).toMatchObject({ passed: true, effect: null });
  });

  it("covers exactly 15 allowlisted drugs", () => {
    expect(ALLOWLISTED_DRUGS).toHaveLength(15);
  });

  it.each([
    ["non-listed drug (lithium-like unknown rxcui)", "999999"],
    ["null rxcui", null],
    ["empty rxcui", ""],
    ["ingredient-level hydroxyzine not on list", "5553"],
  ])("rejects %s", (_n, rxcui) => {
    const input = baseInput();
    input.medication = { ...input.medication, rxcui };
    expect(ruleR02(input)).toMatchObject({
      passed: false,
      effect: "REJECT",
      reasonCodes: ["NOT_ON_FORMULARY"],
    });
  });

  it.each(CONTROLLED_DRUGS.map((d) => [d.name, d.rxcui] as const))(
    "rejects controlled %s",
    (name, rxcui) => {
      const input = baseInput();
      input.medication = { ...input.medication, name, rxcui };
      expect(ruleR02(input).passed).toBe(false);
    },
  );

  it("does not trust a caller formularyId when the RxCUI is not allowlisted", () => {
    const input = baseInput();
    input.medication = { ...input.medication, rxcui: "596", formularyId: "fluoxetine" };
    expect(ruleR02(input).passed).toBe(false);
  });
});
