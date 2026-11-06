import { describe, expect, it } from "vitest";
import { baseInput } from "./fixtures";
import { ruleR06 } from "./r06-refill-limit";

const run = (renewalsSinceLastVisit: number, refillLimit: number) =>
  ruleR06(baseInput({ renewalsSinceLastVisit, refillLimit }));

describe("R06 refill limit", () => {
  // [renewals, limit, passes]
  it.each([
    [0, 2, true],
    [1, 2, true], // limit - 1
    [2, 2, false], // limit
    [3, 2, false], // limit + 1
    [0, 1, true],
    [1, 1, false],
    [4, 5, true],
    [5, 5, false],
    [6, 5, false],
    [0, 0, false], // limit 0: every renewal needs a visit
  ])("renewals %i, limit %i -> passes=%s", (renewals, limit, passes) => {
    const r = run(renewals, limit);
    expect(r.passed).toBe(passes);
    if (!passes) {
      expect(r).toMatchObject({
        effect: "FOLLOW_UP_REQUIRED",
        reasonCodes: ["REFILL_LIMIT_REACHED"],
      });
    }
  });

  it("uses the limit from input, not a hard-coded default", () => {
    expect(run(2, 3).passed).toBe(true);
    expect(run(2, 2).passed).toBe(false);
  });

  it.each([
    [-1, 2],
    [1.5, 2],
    [Number.NaN, 2],
    [1, -1],
    [1, Number.NaN],
    [1, 2.5],
    [1, Number.POSITIVE_INFINITY],
  ])("invalid counts (%s, %s) escalate", (renewals, limit) => {
    expect(run(renewals, limit)).toMatchObject({
      passed: false,
      effect: "ESCALATE",
      reasonCodes: ["INVALID_INPUT"],
    });
  });

  it("missing values escalate", () => {
    const r = ruleR06(baseInput({ refillLimit: undefined as unknown as number }));
    expect(r.effect).toBe("ESCALATE");
  });
});
