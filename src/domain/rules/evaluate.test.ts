import { describe, expect, it } from "vitest";
import { ALLOWLISTED_DRUGS, CONTROLLED_DRUGS } from "../formulary";
import { evaluateEligibility, RULE_ORDER } from "./evaluate";
import { baseInput } from "./fixtures";
import { ruleR13 } from "./r13-ai-signal";
import type { AiResult, CheckInInput, RuleInput } from "./types";

const checkIn = (patch: Partial<CheckInInput>): RuleInput => {
  const b = baseInput();
  return { ...b, checkIn: { ...b.checkIn, ...patch } };
};
const asDrug = (id: string, patch: Partial<RuleInput["medication"]> = {}): RuleInput => {
  const e = [...ALLOWLISTED_DRUGS, ...CONTROLLED_DRUGS].find((d) => d.id === id)!;
  const b = baseInput();
  return {
    ...b,
    medication: {
      ...b.medication,
      name: e.name,
      rxcui: e.rxcui,
      formularyId: e.id,
      controlledSchedule: e.controlledSchedule,
      ...patch,
    },
    activeOrder: { status: "active", intent: "order", rxcui: e.rxcui },
  };
};

describe("R13 AI signal rule", () => {
  it.each<[string, AiResult | undefined, boolean, string?]>([
    ["ok, no signals", { status: "ok", signals: [] }, true],
    [
      "ok, one signal",
      { status: "ok", signals: [{ type: "suicidal_ideation" }] },
      false,
      "LLM_RISK_SIGNAL",
    ],
    ["failed", { status: "failed" }, false, "LLM_FAILURE"],
    ["absent", undefined, false, "LLM_FAILURE"],
    ["null", null as unknown as undefined, false, "LLM_FAILURE"],
    ["malformed status", { status: "weird" } as unknown as AiResult, false, "LLM_FAILURE"],
    [
      "signals not an array",
      { status: "ok", signals: "none" } as unknown as AiResult,
      false,
      "LLM_FAILURE",
    ],
  ])("%s", (_n, ai, ok, code) => {
    const r = ruleR13(baseInput({ ai }));
    expect(r.passed).toBe(ok);
    if (!ok) expect(r).toMatchObject({ effect: "ESCALATE", reasonCodes: [code] });
  });
});

describe("evaluateEligibility", () => {
  it("clean baseline is AUTO_ELIGIBLE with all rules passing, in fixed order", () => {
    const r = evaluateEligibility(baseInput());
    expect(r.outcome).toEqual({ type: "AUTO_ELIGIBLE" });
    expect(r.reasonCodes).toEqual([]);
    expect(r.results.map((x) => x.ruleId)).toEqual(RULE_ORDER.map(([id]) => id));
    expect(r.results.map((x) => x.ruleId)).toEqual([
      "R01",
      "R02",
      "M01",
      "M02",
      "R03",
      "R04",
      "R05",
      "R06",
      "R07",
      "R08",
      "R09",
      "R10",
      "R11",
      "R12",
      "R13",
      "D01",
      "D02",
      "D03",
      "R00",
    ]);
    expect(r.results.every((x) => x.passed)).toBe(true);
  });

  it("results carry exactly {ruleId, passed, detail}", () => {
    for (const x of evaluateEligibility(baseInput()).results) {
      expect(Object.keys(x).sort()).toEqual(["detail", "passed", "ruleId"]);
    }
  });

  it.each(ALLOWLISTED_DRUGS.filter((d) => !/hydroxyzine|trazodone|mirtazapine/.test(d.id)))(
    "plain allowlisted drug $id can be AUTO_ELIGIBLE",
    (d) => {
      expect(evaluateEligibility(asDrug(d.id)).outcome.type).toBe("AUTO_ELIGIBLE");
    },
  );

  it("trazodone 150 mg nightly is auto-eligible; 151 escalates", () => {
    expect(
      evaluateEligibility(asDrug("trazodone", { doseMg: 150, frequency: "nightly" })).outcome.type,
    ).toBe("AUTO_ELIGIBLE");
    expect(
      evaluateEligibility(asDrug("trazodone", { doseMg: 151, frequency: "nightly" })).outcome,
    ).toEqual({ type: "ESCALATE", reasons: ["TRAZODONE_LIMIT_EXCEEDED"] });
  });

  it("mirtazapine needs monitoring", () => {
    expect(evaluateEligibility(asDrug("mirtazapine")).outcome).toEqual({
      type: "ESCALATE",
      reasons: ["MIRTAZAPINE_MONITORING_MISSING"],
    });
    const ok = {
      ...asDrug("mirtazapine"),
      monitoring: { baselineRecorded: true, monthsSinceBaseline: 3, sixMonthRecorded: false },
    };
    expect(evaluateEligibility(ok).outcome.type).toBe("AUTO_ELIGIBLE");
  });

  it.each(["hydroxyzine_hcl", "hydroxyzine_pamoate"])("%s never AUTO_ELIGIBLE", (id) => {
    expect(evaluateEligibility(asDrug(id)).outcome).toEqual({
      type: "ESCALATE",
      reasons: ["HYDROXYZINE_ALWAYS_ESCALATE"],
    });
  });

  describe("single-rule outcomes", () => {
    it.each<[string, RuleInput, string, string]>([
      ["R01", baseInput({ identityVerified: false }), "REJECT", "IDENTITY_NOT_VERIFIED"],
      [
        "R02",
        {
          ...asDrug("fluoxetine", { rxcui: "999999" }),
          activeOrder: { status: "active", intent: "order", rxcui: "999999" },
        },
        "REJECT",
        "NOT_ON_FORMULARY",
      ],
      ["R04", baseInput({ activeOrder: null }), "ESCALATE", "NO_ACTIVE_ORDER"],
      ["R05", baseInput({ requestedChange: "dose" }), "ESCALATE", "CHANGE_REQUESTED"],
      [
        "R06",
        baseInput({ renewalsSinceLastVisit: 2 }),
        "FOLLOW_UP_REQUIRED",
        "REFILL_LIMIT_REACHED",
      ],
      ["R07", checkIn({ phq9: [0, 0, 0, 0, 0, 0, 0, 0, 1] }), "ESCALATE", "PHQ9_ITEM9_POSITIVE"],
      ["R08", checkIn({ phq9: [3, 3, 3, 3, 3, 0, 0, 0, 0] }), "ESCALATE", "PHQ9_TOTAL_HIGH"],
      ["R09", checkIn({ pregnancy: "unsure" }), "ESCALATE", "PREGNANCY_YES_OR_UNSURE"],
      ["R10", checkIn({ severeSideEffect: true }), "ESCALATE", "SEVERE_SIDE_EFFECT"],
      ["R11", checkIn({ maniaScreen: true }), "ESCALATE", "MANIA_SCREEN_POSITIVE"],
      ["R12", checkIn({ requestedHuman: true }), "ESCALATE", "PATIENT_REQUESTED_HUMAN"],
      [
        "R13 signal",
        baseInput({ ai: { status: "ok", signals: [{}] } }),
        "ESCALATE",
        "LLM_RISK_SIGNAL",
      ],
      ["R13 failed", baseInput({ ai: { status: "failed" } }), "ESCALATE", "LLM_FAILURE"],
      ["R13 absent", baseInput({ ai: undefined }), "ESCALATE", "LLM_FAILURE"],
      ["R00", checkIn({ gad7: [1] }), "ESCALATE", "INVALID_INPUT"],
    ])("%s", (_n, input, type, code) => {
      const r = evaluateEligibility(input);
      expect(r.outcome.type).toBe(type);
      expect(r.reasonCodes).toEqual([code]);
    });
  });

  describe("precedence", () => {
    it("REJECT beats ESCALATE and FOLLOW_UP", () => {
      const r = evaluateEligibility(
        baseInput({
          identityVerified: false,
          renewalsSinceLastVisit: 5,
          checkIn: { ...baseInput().checkIn, requestedHuman: true },
        }),
      );
      expect(r.outcome).toEqual({ type: "REJECT", reason: "IDENTITY_NOT_VERIFIED" });
      expect(r.reasonCodes).toEqual([
        "IDENTITY_NOT_VERIFIED",
        "REFILL_LIMIT_REACHED",
        "PATIENT_REQUESTED_HUMAN",
      ]);
    });

    it("first REJECT in rule order is the reason", () => {
      const r = evaluateEligibility({
        ...baseInput({ identityVerified: false }),
        medication: { ...baseInput().medication, rxcui: "999999" },
      });
      expect(r.outcome).toEqual({ type: "REJECT", reason: "IDENTITY_NOT_VERIFIED" });
      expect(r.reasonCodes).toContain("NOT_ON_FORMULARY");
    });

    it("ESCALATE beats FOLLOW_UP_REQUIRED and keeps the refill reason visible", () => {
      const r = evaluateEligibility({
        ...baseInput({ renewalsSinceLastVisit: 2 }),
        checkIn: { ...baseInput().checkIn, phq9: [0, 0, 0, 0, 0, 0, 0, 0, 2] },
      });
      expect(r.outcome).toEqual({
        type: "ESCALATE",
        reasons: ["REFILL_LIMIT_REACHED", "PHQ9_ITEM9_POSITIVE"],
      });
    });

    it("multiple escalations are all listed, deduplicated, in rule order", () => {
      const r = evaluateEligibility(
        checkIn({ pregnancy: "yes", severeSideEffect: true, requestedHuman: true }),
      );
      expect(r.outcome).toEqual({
        type: "ESCALATE",
        reasons: ["PREGNANCY_YES_OR_UNSURE", "SEVERE_SIDE_EFFECT", "PATIENT_REQUESTED_HUMAN"],
      });
    });

    it("AI cannot rescue a failing rule: clean AI result with item 9 = 3 still escalates", () => {
      const r = evaluateEligibility({
        ...baseInput({ ai: { status: "ok", signals: [] } }),
        checkIn: { ...baseInput().checkIn, phq9: [0, 0, 0, 0, 0, 0, 0, 0, 3] },
      });
      expect(r.outcome.type).toBe("ESCALATE");
    });
  });

  describe("fail closed", () => {
    it("absent AI result escalates an otherwise perfect request", () => {
      expect(evaluateEligibility(baseInput({ ai: undefined })).outcome).toEqual({
        type: "ESCALATE",
        reasons: ["LLM_FAILURE"],
      });
    });

    it("a throwing/garbage input never yields AUTO_ELIGIBLE", () => {
      const garbage = {} as unknown as RuleInput;
      const r = evaluateEligibility(garbage);
      expect(r.outcome.type).not.toBe("AUTO_ELIGIBLE");
      expect(r.results).toHaveLength(RULE_ORDER.length);
    });

    it("null checkIn / medication never yields AUTO_ELIGIBLE", () => {
      for (const bad of [
        { ...baseInput(), checkIn: null },
        { ...baseInput(), medication: null },
      ]) {
        expect(evaluateEligibility(bad as unknown as RuleInput).outcome.type).not.toBe(
          "AUTO_ELIGIBLE",
        );
      }
    });
  });

  describe("controlled substances", () => {
    const variants: Array<[string, (i: RuleInput) => RuleInput]> = [
      ["clean", (i) => i],
      ["with ok AI", (i) => ({ ...i, ai: { status: "ok", signals: [] } })],
      ["with failed AI", (i) => ({ ...i, ai: { status: "failed" } })],
      ["no AI", (i) => ({ ...i, ai: undefined })],
      ["identity unverified", (i) => ({ ...i, identityVerified: false })],
      [
        "flag says non-controlled",
        (i) => ({ ...i, medication: { ...i.medication, controlledSchedule: null } }),
      ],
      [
        "formulary id claims fluoxetine",
        (i) => ({ ...i, medication: { ...i.medication, formularyId: "fluoxetine" } }),
      ],
    ];

    describe.each(CONTROLLED_DRUGS)("$name", (d) => {
      it.each(variants)("never AUTO_ELIGIBLE (%s)", (_n, f) => {
        const r = evaluateEligibility(f(asDrug(d.id)));
        expect(r.outcome.type).not.toBe("AUTO_ELIGIBLE");
        expect(r.reasonCodes).toContain("CONTROLLED_SUBSTANCE");
      });
    });

    it("does not read the AI result at all (blocked before the AI step is reachable)", () => {
      const input = asDrug("alprazolam");
      Object.defineProperty(input, "ai", {
        get() {
          throw new Error("AI result must not be read for controlled drugs");
        },
        enumerable: true,
      });
      const r = evaluateEligibility(input);
      expect(r.reasonCodes).toContain("CONTROLLED_SUBSTANCE");
      expect(r.reasonCodes).not.toContain("LLM_FAILURE");
      expect(r.results.find((x) => x.ruleId === "R13")?.detail).toMatch(/not evaluated/);
    });
  });

  describe("custom refill limit from input", () => {
    it.each([
      [2, 3, "AUTO_ELIGIBLE"],
      [3, 3, "FOLLOW_UP_REQUIRED"],
      [1, 2, "AUTO_ELIGIBLE"],
      [2, 2, "FOLLOW_UP_REQUIRED"],
    ])("renewals %i / limit %i -> %s", (renewals, limit, type) => {
      expect(
        evaluateEligibility(baseInput({ renewalsSinceLastVisit: renewals, refillLimit: limit }))
          .outcome.type,
      ).toBe(type);
    });
  });
});
