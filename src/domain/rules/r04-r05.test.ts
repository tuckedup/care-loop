import { describe, expect, it } from "vitest";
import { baseInput } from "./fixtures";
import { ruleR04, ruleR05 } from "./r04-r05";
import type { MedicationRequestStatus, RuleInput } from "./types";

const withOrder = (o: Partial<NonNullable<RuleInput["activeOrder"]>> | null): RuleInput => {
  const base = baseInput();
  return { ...base, activeOrder: o === null ? null : { ...base.activeOrder!, ...o } };
};

describe("R04 active clinician order", () => {
  it("passes for an active order with intent order and matching rxcui", () => {
    expect(ruleR04(baseInput())).toMatchObject({ passed: true, effect: null });
  });

  it.each([
    "on-hold",
    "cancelled",
    "completed",
    "entered-in-error",
    "stopped",
    "draft",
    "unknown",
  ] as MedicationRequestStatus[])("escalates for status %s", (status) => {
    expect(ruleR04(withOrder({ status }))).toMatchObject({
      passed: false,
      effect: "ESCALATE",
      reasonCodes: ["NO_ACTIVE_ORDER"],
    });
  });

  it.each(["proposal", "plan", "original-order", "", "ORDER"])(
    "escalates for intent %j",
    (intent) => {
      expect(ruleR04(withOrder({ intent })).passed).toBe(false);
    },
  );

  it("escalates when there is no order", () => {
    expect(ruleR04(withOrder(null)).passed).toBe(false);
  });

  it("escalates when the order is for a different drug", () => {
    expect(ruleR04(withOrder({ rxcui: "36437" })).passed).toBe(false);
  });

  it("escalates when either rxcui is missing", () => {
    expect(ruleR04(withOrder({ rxcui: null })).passed).toBe(false);
    const base = baseInput();
    const noMedRxcui = { ...base, medication: { ...base.medication, rxcui: null } };
    expect(
      ruleR04({ ...noMedRxcui, activeOrder: { ...base.activeOrder!, rxcui: null } }).passed,
    ).toBe(false);
  });
});

describe("R05 no change requested", () => {
  it("passes for none", () => {
    expect(ruleR05(baseInput({ requestedChange: "none" }))).toMatchObject({
      passed: true,
      effect: null,
    });
  });

  it.each(["dose", "frequency", "drug", "other"] as const)("escalates for %s", (c) => {
    expect(ruleR05(baseInput({ requestedChange: c }))).toMatchObject({
      passed: false,
      effect: "ESCALATE",
      reasonCodes: ["CHANGE_REQUESTED"],
    });
  });

  it.each([undefined, null, "", "None", "increase my dose please"] as unknown[])(
    "fails closed for unrecognised/disguised value %j",
    (v) => {
      expect(ruleR05(baseInput({ requestedChange: v as "none" })).passed).toBe(false);
    },
  );
});
