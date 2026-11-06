import { describe, expect, it } from "vitest";
import { baseInput } from "./fixtures";
import { ruleR08 } from "./r08-phq9-total";
import type { RuleInput } from "./types";

/** Build PHQ-9 answers (item 9 kept at 0) summing to `total` (max 24 that way). */
function answersFor(total: number): number[] {
  const items = Array<number>(9).fill(0);
  let left = total;
  for (let i = 0; i < 8 && left > 0; i++) {
    const v = Math.min(3, left);
    items[i] = v;
    left -= v;
  }
  if (left > 0) items[8] = left; // totals above 24 need item 9
  return items;
}

const run = (total: number, prior: number | null): ReturnType<typeof ruleR08> => {
  const base = baseInput();
  return ruleR08({
    ...base,
    checkIn: { ...base.checkIn, phq9: answersFor(total) },
    priorPhq9Total: prior,
  });
};

describe("R08 PHQ-9 total / rise", () => {
  it.each([
    [0, null, true],
    [14, null, true], // just below absolute threshold
    [15, null, false], // at threshold
    [16, null, false],
    [27, null, false],
  ])("total %i, no prior -> passes=%s", (t, p, ok) => {
    const r = run(t, p);
    expect(r.passed).toBe(ok);
    if (!ok) expect(r.reasonCodes).toEqual(["PHQ9_TOTAL_HIGH"]);
  });

  it.each([
    [8, 4, true], // rise 4
    [9, 4, false], // rise 5
    [10, 4, false], // rise 6
    [5, 0, false], // rise 5 from zero
    [4, 0, true],
    [14, 10, true], // rise 4 under absolute threshold
    [14, 9, false], // rise 5 under absolute threshold
  ])("total %i, prior %i -> passes=%s", (t, p, ok) => {
    const r = run(t, p);
    expect(r.passed).toBe(ok);
    if (!ok) expect(r.reasonCodes).toEqual(["PHQ9_RISE"]);
  });

  it("falling scores never trigger the rise rule", () => {
    expect(run(3, 20).passed).toBe(true);
    expect(run(14, 27).passed).toBe(true);
  });

  it("high total with high prior (no rise) still escalates on the absolute rule only", () => {
    const r = run(18, 17);
    expect(r.reasonCodes).toEqual(["PHQ9_TOTAL_HIGH"]);
  });

  it("both rules can fire together", () => {
    const r = run(15, 10);
    expect(r.passed).toBe(false);
    expect(r.reasonCodes).toEqual(["PHQ9_TOTAL_HIGH", "PHQ9_RISE"]);
  });

  it("no prior score: rise rule does not apply", () => {
    expect(run(14, null).passed).toBe(true);
  });

  it.each([-1, 28, 1.5, Number.NaN, undefined as unknown as number])(
    "invalid prior %s escalates",
    (prior) => {
      expect(run(5, prior)).toMatchObject({
        passed: false,
        effect: "ESCALATE",
        reasonCodes: ["INVALID_INPUT"],
      });
    },
  );

  it("invalid current responses escalate", () => {
    const base = baseInput();
    const input: RuleInput = { ...base, checkIn: { ...base.checkIn, phq9: [1, 2] } };
    expect(ruleR08(input).reasonCodes).toEqual(["INVALID_INPUT"]);
  });
});
