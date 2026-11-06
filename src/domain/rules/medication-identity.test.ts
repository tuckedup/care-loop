import { describe, expect, it } from "vitest";
import { ALLOWLISTED_DRUGS, CONTROLLED_DRUGS, FORMULARY } from "../formulary";
import { evaluateEligibility } from "./evaluate";
import { baseInput } from "./fixtures";
import { ruleM01, ruleM02 } from "./medication-identity";
import { isAiPathAllowed, isControlled } from "./r03-controlled";
import type { ControlledSchedule, RuleInput } from "./types";

const withMed = (patch: Partial<RuleInput["medication"]>): RuleInput => {
  const b = baseInput();
  const medication = { ...b.medication, ...patch };
  return {
    ...b,
    medication,
    activeOrder: { status: "active", intent: "order", rxcui: medication.rxcui },
  };
};

describe("hostile mislabelled medication combinations", () => {
  const names = [
    "alprazolam",
    "ALPRAZOLAM",
    "  Alprazolam  ",
    "Alpra-zolam",
    "alpra zolam",
    "Xanax",
    "XANAX 1mg",
    "lisdexamfetamine",
    "Lisdexamfetamine Dimesylate",
    "Vyvanse",
    "vyvanse 30",
    "oxycodone",
    "Percocet",
    "fluoxetine and alprazolam",
    "sertraline",
    "",
    "   ",
    "unknown drug",
  ];
  const formularyIds: Array<string | null> = [
    null,
    "fluoxetine",
    "sertraline",
    "alprazolam",
    "nope",
  ];
  const schedules: Array<ControlledSchedule | null> = [null, "IV"];
  // fluoxetine is the label every case below tries to hide behind (plus every other allowlisted RxCUI)
  const rxcuis = [...new Set(ALLOWLISTED_DRUGS.map((d) => d.rxcui))];

  it("no hostile combination (name x formularyId x schedule x allowlisted RxCUI) is AUTO_ELIGIBLE", () => {
    let n = 0;
    for (const name of names)
      for (const formularyId of formularyIds)
        for (const controlledSchedule of schedules)
          for (const rxcui of rxcuis) {
            const input = withMed({ name, formularyId, controlledSchedule, rxcui });
            // "sertraline" with sertraline's own RxCUI and id is a legitimate, consistent request
            const legit =
              name === "sertraline" &&
              rxcui === "36437" &&
              controlledSchedule === null &&
              (formularyId === null || formularyId === "sertraline");
            const r = evaluateEligibility(input);
            n++;
            if (!legit) {
              expect(
                r.outcome.type,
                JSON.stringify({ name, formularyId, controlledSchedule, rxcui }),
              ).not.toBe("AUTO_ELIGIBLE");
            }
          }
    expect(n).toBeGreaterThan(1000);
  });

  it.each(["alprazolam", "Xanax", "lisdexamfetamine", "Vyvanse", " ALPRAZOLAM "])(
    "name %j with schedule null and allowlisted fluoxetine RxCUI is controlled and out of the AI path",
    (name) => {
      const input = withMed({
        name,
        controlledSchedule: null,
        formularyId: "fluoxetine",
        rxcui: "4493",
      });
      expect(isControlled(input)).toBe(true);
      expect(isAiPathAllowed(input)).toBe(false);
      const r = evaluateEligibility(input);
      expect(r.reasonCodes).toContain("CONTROLLED_SUBSTANCE");
      expect(r.reasonCodes).toContain("MEDICATION_IDENTITY_MISMATCH");
      expect(r.outcome.type).toBe("ESCALATE");
    },
  );

  it("an unrecognised drug (oxycodone) behind a fluoxetine RxCUI escalates as an identity mismatch", () => {
    const r = evaluateEligibility(withMed({ name: "oxycodone", formularyId: null, rxcui: "4493" }));
    expect(r.outcome).toMatchObject({ type: "ESCALATE" });
    expect(r.reasonCodes).toContain("MEDICATION_IDENTITY_MISMATCH");
  });

  it("controlled brand aliases come from the formulary data", () => {
    const aliases = CONTROLLED_DRUGS.flatMap((d) => d.aliases);
    expect(aliases).toEqual(
      expect.arrayContaining(["alprazolam", "xanax", "lisdexamfetamine", "vyvanse"]),
    );
  });
});

describe("M01 medication identity", () => {
  it("passes when name, formularyId and RxCUI agree for every allowlisted drug", () => {
    for (const d of ALLOWLISTED_DRUGS) {
      expect(
        ruleM01(withMed({ name: d.name, formularyId: d.id, rxcui: d.rxcui })).passed,
        d.id,
      ).toBe(true);
    }
  });

  it.each([
    ["name of another allowlisted drug", { name: "sertraline" }],
    ["formularyId for a different RxCUI", { formularyId: "sertraline" }],
    ["unknown formularyId", { formularyId: "nope" }],
    ["empty name", { name: "" }],
    [
      "citalopram name on escitalopram RxCUI",
      { name: "citalopram", rxcui: "321988", formularyId: null },
    ],
    [
      "escitalopram name on citalopram RxCUI",
      { name: "escitalopram", rxcui: "2556", formularyId: null },
    ],
    [
      "desvenlafaxine name on venlafaxine RxCUI",
      { name: "desvenlafaxine ER", rxcui: "39786", formularyId: null },
    ],
  ])("escalates on %s", (_n, patch) => {
    expect(ruleM01(withMed(patch))).toMatchObject({
      passed: false,
      effect: "ESCALATE",
      reasonCodes: ["MEDICATION_IDENTITY_MISMATCH"],
    });
  });

  it("does not confuse escitalopram/desvenlafaxine with their substrings", () => {
    expect(
      ruleM01(withMed({ name: "escitalopram", rxcui: "321988", formularyId: "escitalopram" }))
        .passed,
    ).toBe(true);
    expect(
      ruleM01(withMed({ name: "desvenlafaxine", rxcui: "734064", formularyId: "desvenlafaxine" }))
        .passed,
    ).toBe(true);
  });

  it("leaves a null RxCUI to R02", () => {
    const r = evaluateEligibility(withMed({ rxcui: null }));
    expect(r.outcome.type).toBe("REJECT");
  });
});

describe("M02 dose form", () => {
  const med = (name: string, rxcui: string, formularyId: string | null = null) =>
    ruleM02(withMed({ name, rxcui, formularyId }));

  it.each([
    ["bupropion IR", "42347", null],
    ["bupropion immediate release", "42347", null],
    ["Bupropion Immediate-Release", "42347", null],
    ["bupropion", "42347", null], // form missing
    ["bupropion CR", "42347", null],
    ["bupropion SR", "42347", "bupropion_xl"], // form contradicts formularyId
    ["bupropion XL", "42347", "bupropion_sr"],
    ["venlafaxine", "39786", null], // form missing
    ["venlafaxine IR", "39786", null],
    ["venlafaxine immediate release", "39786", "venlafaxine_er"],
    ["venlafaxine ER IR", "39786", null], // conflicting forms
    ["sertraline ER", "36437", null], // form word on a non-form-specific entry
    ["fluoxetine IR", "4493", null],
    ["paroxetine CR", "32937", null],
  ])("escalates %j", (name, rxcui, id) => {
    expect(med(name, rxcui, id)).toMatchObject({
      passed: false,
      effect: "ESCALATE",
      reasonCodes: ["DOSE_FORM_NOT_ALLOWLISTED"],
    });
  });

  it.each([
    ["bupropion SR", "42347", null],
    ["bupropion XL", "42347", "bupropion_xl"],
    ["bupropion sustained-release", "42347", "bupropion_sr"],
    ["venlafaxine ER", "39786", "venlafaxine_er"],
    ["Venlafaxine extended release", "39786", null],
    ["sertraline", "36437", null],
    ["fluoxetine", "4493", "fluoxetine"],
  ])("passes %j", (name, rxcui, id) => {
    expect(med(name, rxcui, id).passed).toBe(true);
  });

  it("whole words only: 'er' inside other words is not a form", () => {
    expect(med("sertraline", "36437").passed).toBe(true);
    expect(med("buspirone", "1827").passed).toBe(true);
  });

  it("full pipeline: bupropion IR and venlafaxine IR are not AUTO_ELIGIBLE", () => {
    for (const [name, rxcui] of [
      ["bupropion IR", "42347"],
      ["venlafaxine immediate release", "39786"],
    ] as const) {
      const r = evaluateEligibility(withMed({ name, rxcui, formularyId: null }));
      expect(r.outcome.type).toBe("ESCALATE");
      expect(r.reasonCodes).toContain("DOSE_FORM_NOT_ALLOWLISTED");
    }
  });

  it("every allowlisted display name passes its own form check", () => {
    for (const d of FORMULARY.filter((x) => x.allowlisted)) {
      expect(
        ruleM02(withMed({ name: d.name, rxcui: d.rxcui, formularyId: d.id })).passed,
        d.id,
      ).toBe(true);
    }
  });
});

describe("REJECT keeps escalation signals visible", () => {
  it("identity unverified + item 9 >= 1 => REJECT with both reason codes", () => {
    const b = baseInput({ identityVerified: false });
    const input = { ...b, checkIn: { ...b.checkIn, phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] } };
    const r = evaluateEligibility(input);
    expect(r.outcome).toEqual({ type: "REJECT", reason: "IDENTITY_NOT_VERIFIED" });
    expect(r.reasonCodes).toEqual(["IDENTITY_NOT_VERIFIED", "PHQ9_ITEM9_POSITIVE"]);
  });
});

describe("evaluateEligibility is total", () => {
  it.each([null, undefined, 0, "x", [], {}, { medication: null }, { checkIn: {} }] as unknown[])(
    "garbage %j => ESCALATE INVALID_INPUT or other non-approval, never throws",
    (g) => {
      const r = evaluateEligibility(g as RuleInput);
      expect(r.outcome.type).toBe("ESCALATE");
      expect(r.reasonCodes).toContain("INVALID_INPUT");
      expect(r.results.length).toBeGreaterThan(0);
    },
  );

  it("null/undefined/primitive input returns exactly ESCALATE [INVALID_INPUT]", () => {
    for (const g of [null, undefined, 5, "x"] as unknown[]) {
      expect(evaluateEligibility(g as RuleInput).outcome).toEqual({
        type: "ESCALATE",
        reasons: ["INVALID_INPUT"],
      });
    }
  });

  it("a throwing getter anywhere cannot approve", () => {
    const input = baseInput();
    Object.defineProperty(input, "medication", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    expect(evaluateEligibility(input).outcome.type).toBe("ESCALATE");
  });
});
