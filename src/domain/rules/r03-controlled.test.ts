import { describe, expect, it } from "vitest";
import { CONTROLLED_DRUGS } from "../formulary";
import { baseInput } from "./fixtures";
import { isAiPathAllowed, isControlled, ruleR03 } from "./r03-controlled";
import type { ControlledSchedule, RuleInput } from "./types";

const withMed = (patch: Partial<RuleInput["medication"]>): RuleInput => {
  const input = baseInput();
  return { ...input, medication: { ...input.medication, ...patch } };
};

describe("R03 controlled substance hard block", () => {
  it("passes a non-controlled allowlisted drug and allows the AI path", () => {
    const input = baseInput();
    expect(ruleR03(input)).toMatchObject({ passed: true, effect: null });
    expect(isAiPathAllowed(input)).toBe(true);
  });

  it.each(CONTROLLED_DRUGS.map((d) => [d.name, d.rxcui, d.controlledSchedule, d.id] as const))(
    "blocks %s",
    (name, rxcui, controlledSchedule, formularyId) => {
      const input = withMed({ name, rxcui, controlledSchedule, formularyId });
      expect(ruleR03(input)).toMatchObject({
        passed: false,
        effect: "ESCALATE",
        reasonCodes: ["CONTROLLED_SUBSTANCE"],
      });
      expect(isAiPathAllowed(input)).toBe(false);
    },
  );

  it.each(["II", "III", "IV", "V"] as ControlledSchedule[])("blocks any schedule %s", (s) => {
    const input = withMed({ controlledSchedule: s });
    expect(ruleR03(input).passed).toBe(false);
    expect(isAiPathAllowed(input)).toBe(false);
  });

  it("blocks when only the RxCUI reveals a controlled drug (schedule flag lies)", () => {
    const input = withMed({ rxcui: "596", controlledSchedule: null, formularyId: null });
    expect(isControlled(input)).toBe(true);
    expect(isAiPathAllowed(input)).toBe(false);
  });

  it("blocks when only the formularyId reveals a controlled drug", () => {
    const input = withMed({ rxcui: null, controlledSchedule: null, formularyId: "alprazolam" });
    expect(isControlled(input)).toBe(true);
  });

  it("fails closed when the schedule is unknown (undefined)", () => {
    const input = withMed({ controlledSchedule: undefined as unknown as null });
    expect(isControlled(input)).toBe(true);
    expect(isAiPathAllowed(input)).toBe(false);
  });
});
