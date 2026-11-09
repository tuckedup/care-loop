import { describe, expect, it } from "vitest";
import { wilsonInterval } from "../evals/wilson";

describe("wilsonInterval", () => {
  it("a perfect 116/116 still has a lower bound below 1 (about 0.968)", () => {
    const { low, high } = wilsonInterval(116, 116);
    expect(low).toBeCloseTo(0.968, 3);
    expect(high).toBeCloseTo(1, 10);
  });

  it("matches a textbook value for 8/10 (0.490 to 0.943)", () => {
    const { low, high } = wilsonInterval(8, 10);
    expect(low).toBeCloseTo(0.49, 2);
    expect(high).toBeCloseTo(0.943, 2);
  });

  it("rejects impossible inputs", () => {
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 4)).toThrow(RangeError);
  });
});
