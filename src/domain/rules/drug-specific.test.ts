import { describe, expect, it } from "vitest";
import { ALLOWLISTED_DRUGS } from "../formulary";
import { ruleD01Trazodone, ruleD02Mirtazapine, ruleD03Hydroxyzine } from "./drug-specific";
import { baseInput } from "./fixtures";
import type { MirtazapineMonitoringInput, RuleInput } from "./types";

const med = (id: string, patch: Partial<RuleInput["medication"]> = {}): RuleInput => {
  const entry = ALLOWLISTED_DRUGS.find((d) => d.id === id)!;
  const base = baseInput();
  return {
    ...base,
    medication: {
      ...base.medication,
      name: entry.name,
      rxcui: entry.rxcui,
      formularyId: entry.id,
      ...patch,
    },
  };
};

describe("D01 trazodone <= 150 mg nightly", () => {
  it.each([
    [50, "nightly", true],
    [149, "nightly", true],
    [150, "nightly", true], // boundary
    [151, "nightly", false],
    [300, "nightly", false],
    [100, "daily", false],
    [100, "twice daily", false],
    [150, null, false],
    [150, " Nightly ", true],
  ])("%i mg %j -> passes=%s", (doseMg, frequency, ok) => {
    const r = ruleD01Trazodone(med("trazodone", { doseMg, frequency }));
    expect(r.passed).toBe(ok);
    if (!ok)
      expect(r).toMatchObject({ effect: "ESCALATE", reasonCodes: ["TRAZODONE_LIMIT_EXCEEDED"] });
  });

  it.each([null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])("invalid dose %s escalates", (d) => {
    const r = ruleD01Trazodone(med("trazodone", { doseMg: d, frequency: "nightly" }));
    expect(r).toMatchObject({ passed: false, effect: "ESCALATE" });
  });

  it("is not applicable to other drugs, even at high doses", () => {
    expect(ruleD01Trazodone(med("sertraline", { doseMg: 200, frequency: "daily" })).passed).toBe(
      true,
    );
  });

  it("cannot be skipped by mislabelling: identified by name alone", () => {
    const r = ruleD01Trazodone(
      med("sertraline", { name: "Trazodone", doseMg: 300, frequency: "nightly" }),
    );
    expect(r.passed).toBe(false);
  });

  it("cannot be skipped by mislabelling: identified by RxCUI alone", () => {
    const r = ruleD01Trazodone(
      med("sertraline", {
        name: "x",
        rxcui: "10737",
        formularyId: null,
        doseMg: 300,
        frequency: "nightly",
      }),
    );
    expect(r.passed).toBe(false);
  });
});

const mon = (patch: Partial<MirtazapineMonitoringInput> = {}): MirtazapineMonitoringInput => ({
  baselineRecorded: true,
  monthsSinceBaseline: 2,
  sixMonthRecorded: false,
  ...patch,
});
const mirt = (monitoring: MirtazapineMonitoringInput | null): RuleInput => ({
  ...med("mirtazapine"),
  monitoring,
});

describe("D02 mirtazapine monitoring", () => {
  it.each<[string, MirtazapineMonitoringInput | null, boolean]>([
    ["no monitoring data", null, false],
    ["baseline missing", mon({ baselineRecorded: false }), false],
    ["baseline only, 0 months", mon({ monthsSinceBaseline: 0 }), true],
    ["baseline only, 5 months (not yet due)", mon({ monthsSinceBaseline: 5 }), true],
    ["6 months, six-month missing", mon({ monthsSinceBaseline: 6 }), false],
    ["7 months, six-month missing", mon({ monthsSinceBaseline: 7 }), false],
    ["6 months, six-month recorded", mon({ monthsSinceBaseline: 6, sixMonthRecorded: true }), true],
    [
      "12 months, six-month recorded",
      mon({ monthsSinceBaseline: 12, sixMonthRecorded: true }),
      true,
    ],
  ])("%s -> passes=%s", (_n, m, ok) => {
    const r = ruleD02Mirtazapine(mirt(m));
    expect(r.passed).toBe(ok);
    if (!ok)
      expect(r).toMatchObject({
        effect: "ESCALATE",
        reasonCodes: ["MIRTAZAPINE_MONITORING_MISSING"],
      });
  });

  it.each([null, -1, 2.5, Number.NaN])("unknown/invalid months %s escalates", (months) => {
    const r = ruleD02Mirtazapine(mirt(mon({ monthsSinceBaseline: months })));
    expect(r).toMatchObject({ passed: false, effect: "ESCALATE", reasonCodes: ["INVALID_INPUT"] });
  });

  it("is not applicable to other drugs without monitoring data", () => {
    expect(ruleD02Mirtazapine(med("sertraline")).passed).toBe(true);
  });

  it("identified by name alone", () => {
    const input = { ...med("sertraline", { name: "Mirtazapine" }), monitoring: null };
    expect(ruleD02Mirtazapine(input).passed).toBe(false);
  });
});

describe("D03 hydroxyzine always escalates", () => {
  it.each(["hydroxyzine_hcl", "hydroxyzine_pamoate"])("%s escalates", (id) => {
    expect(ruleD03Hydroxyzine(med(id, { doseMg: 10, frequency: "daily" }))).toMatchObject({
      passed: false,
      effect: "ESCALATE",
      reasonCodes: ["HYDROXYZINE_ALWAYS_ESCALATE"],
    });
  });

  it("escalates regardless of dose, however small or clean the request", () => {
    expect(
      ruleD03Hydroxyzine(med("hydroxyzine_hcl", { doseMg: 1, frequency: "nightly" })).passed,
    ).toBe(false);
  });

  it("identified by name alone and by RxCUI alone", () => {
    expect(ruleD03Hydroxyzine(med("sertraline", { name: "Hydroxyzine HCl" })).passed).toBe(false);
    expect(
      ruleD03Hydroxyzine(med("sertraline", { name: "x", rxcui: "203182", formularyId: null }))
        .passed,
    ).toBe(false);
  });

  it("does not affect other drugs", () => {
    expect(ruleD03Hydroxyzine(baseInput()).passed).toBe(true);
  });
});
