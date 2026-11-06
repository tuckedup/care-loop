import { describe, expect, it } from "vitest";
import { baseInput } from "./fixtures";
import { ITEM9_ESCALATION_THRESHOLD, ruleR07 } from "./r07-item9";
import type { RuleInput } from "./types";

const withPhq9 = (phq9: number[]): RuleInput => {
  const base = baseInput();
  return { ...base, checkIn: { ...base.checkIn, phq9 } };
};

describe("R07 PHQ-9 item 9", () => {
  it("threshold is 1 (more conservative than KP >= 2, see ADR-003)", () => {
    expect(ITEM9_ESCALATION_THRESHOLD).toBe(1);
  });

  it.each([
    [0, true],
    [1, false],
    [2, false],
    [3, false],
  ])("item 9 = %i -> passes=%s", (v, passes) => {
    const r = ruleR07(withPhq9([0, 0, 0, 0, 0, 0, 0, 0, v]));
    expect(r.passed).toBe(passes);
    if (!passes) {
      expect(r).toMatchObject({ effect: "ESCALATE", reasonCodes: ["PHQ9_ITEM9_POSITIVE"] });
    }
  });

  it("other items high with item 9 zero does not trigger R07", () => {
    expect(ruleR07(withPhq9([3, 3, 3, 3, 3, 3, 3, 3, 0])).passed).toBe(true);
  });

  it.each([[[]], [[0, 0, 0]], [[0, 0, 0, 0, 0, 0, 0, 0, 4]], [[0, 0, 0, 0, 0, 0, 0, 0, -1]]])(
    "invalid %j escalates",
    (phq9) => {
      expect(ruleR07(withPhq9(phq9))).toMatchObject({
        passed: false,
        effect: "ESCALATE",
        reasonCodes: ["INVALID_INPUT"],
      });
    },
  );

  it("missing check-in escalates", () => {
    const r = ruleR07({ ...baseInput(), checkIn: undefined as unknown as RuleInput["checkIn"] });
    expect(r.passed).toBe(false);
  });
});
