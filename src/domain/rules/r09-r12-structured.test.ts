import { describe, expect, it } from "vitest";
import { baseInput } from "./fixtures";
import { ruleR09, ruleR10, ruleR11, ruleR12 } from "./r09-r12-structured";
import type { CheckInInput, RuleInput } from "./types";

const withCheckIn = (patch: Partial<CheckInInput>): RuleInput => {
  const base = baseInput();
  return { ...base, checkIn: { ...base.checkIn, ...patch } };
};

describe("R09 pregnancy", () => {
  it.each([
    ["no", true],
    ["yes", false],
    ["unsure", false],
    [undefined, false],
    ["", false],
    ["No", false],
  ])("pregnancy %j -> passes=%s", (v, ok) => {
    const r = ruleR09(withCheckIn({ pregnancy: v as CheckInInput["pregnancy"] }));
    expect(r.passed).toBe(ok);
    if (!ok)
      expect(r).toMatchObject({ effect: "ESCALATE", reasonCodes: ["PREGNANCY_YES_OR_UNSURE"] });
  });
});

describe.each([
  ["R10", ruleR10, "severeSideEffect", "SEVERE_SIDE_EFFECT"],
  ["R11", ruleR11, "maniaScreen", "MANIA_SCREEN_POSITIVE"],
  ["R12", ruleR12, "requestedHuman", "PATIENT_REQUESTED_HUMAN"],
] as const)("%s", (id, rule, field, code) => {
  it("passes when false", () => {
    expect(rule(withCheckIn({ [field]: false }))).toMatchObject({
      ruleId: id,
      passed: true,
      effect: null,
    });
  });
  it("escalates when true with its own reason code", () => {
    expect(rule(withCheckIn({ [field]: true }))).toMatchObject({
      ruleId: id,
      passed: false,
      effect: "ESCALATE",
      reasonCodes: [code],
    });
  });
  it.each([undefined, null, "false", 0] as unknown[])("fails closed for %j", (v) => {
    expect(rule(withCheckIn({ [field]: v } as Partial<CheckInInput>)).passed).toBe(false);
  });
});

describe("distinct reason codes", () => {
  it("each rule emits a different code", () => {
    const all = withCheckIn({
      pregnancy: "yes",
      severeSideEffect: true,
      maniaScreen: true,
      requestedHuman: true,
    });
    const codes = [ruleR09, ruleR10, ruleR11, ruleR12].flatMap((r) => r(all).reasonCodes);
    expect(new Set(codes).size).toBe(4);
  });

  it("missing check-in escalates every rule", () => {
    const input = { ...baseInput(), checkIn: undefined as unknown as CheckInInput };
    for (const r of [ruleR09, ruleR10, ruleR11, ruleR12]) expect(r(input).passed).toBe(false);
  });
});
