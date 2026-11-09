import { describe, expect, it } from "vitest";
import { clusteredSe, mean, passHatK } from "../evals/stats";

describe("passHatK (tau-bench unbiased estimator C(c,k)/C(n,k))", () => {
  it("is 1 when every trial succeeded and 0 when fewer than k did", () => {
    expect(passHatK(5, 5, 5)).toBe(1);
    expect(passHatK(5, 4, 5)).toBe(0);
    expect(passHatK(3, 0, 1)).toBe(0);
  });

  it("matches the closed form", () => {
    // C(4,2)/C(5,2) = 6/10
    expect(passHatK(5, 4, 2)).toBeCloseTo(0.6, 12);
    // k = 1 is the plain success rate
    expect(passHatK(10, 7, 1)).toBeCloseTo(0.7, 12);
  });

  it("falls as k grows for a task that sometimes fails", () => {
    expect(passHatK(8, 6, 1)).toBeGreaterThan(passHatK(8, 6, 3));
    expect(passHatK(8, 6, 3)).toBeGreaterThan(passHatK(8, 6, 6));
  });

  it("rejects bad input", () => {
    expect(() => passHatK(3, 4, 1)).toThrow(RangeError);
    expect(() => passHatK(3, 2, 4)).toThrow(RangeError);
    expect(() => passHatK(0, 0, 1)).toThrow(RangeError);
  });
});

describe("clusteredSe", () => {
  it("is zero when nothing varies", () => {
    expect(clusteredSe([1, 1, 1, 1], ["a", "a", "b", "b"])).toBe(0);
  });

  it("is larger than the naive standard error when a cluster moves together", () => {
    const values = [1, 1, 0, 0, 1, 1, 0, 0];
    const clusters = ["a", "a", "b", "b", "a", "a", "b", "b"];
    const m = mean(values);
    const naive = Math.sqrt(
      values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length * (values.length - 1)),
    );
    expect(clusteredSe(values, clusters)).toBeGreaterThan(naive);
  });

  it("equals the independent estimate when every item is its own cluster", () => {
    const values = [1, 0, 1, 1, 0];
    const own = values.map((_, i) => `c${i}`);
    const m = mean(values);
    const expected = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0)) / values.length;
    expect(clusteredSe(values, own)).toBeCloseTo(expected, 12);
  });

  it("rejects mismatched input", () => {
    expect(() => clusteredSe([1], [])).toThrow(RangeError);
    expect(() => clusteredSe([], [])).toThrow(RangeError);
  });
});
