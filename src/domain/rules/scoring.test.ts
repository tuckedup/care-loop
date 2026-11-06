import { describe, expect, it } from "vitest";
import { gad7Band, phq9Band, phq9Item9, scoreGad7, scorePhq9 } from "./scoring";

const nine = (n: number) => Array<number>(9).fill(n);
const seven = (n: number) => Array<number>(7).fill(n);

describe("scorePhq9", () => {
  it.each([
    [nine(0), 0],
    [nine(1), 9],
    [nine(3), 27],
    [[1, 2, 3, 0, 1, 2, 3, 0, 1], 13],
  ])("%j -> %i", (items, total) => expect(scorePhq9(items)).toBe(total));

  it.each([
    ["short", [0, 0, 0]],
    ["long", [...nine(0), 0]],
    ["empty", []],
    ["out of range high", [...nine(0).slice(1), 4]],
    ["negative", [-1, ...nine(0).slice(1)]],
    ["fractional", [0.5, ...nine(0).slice(1)]],
    ["NaN", [Number.NaN, ...nine(0).slice(1)]],
  ])("invalid (%s) -> null", (_n, items) => {
    expect(scorePhq9(items)).toBeNull();
    expect(phq9Item9(items)).toBeNull();
  });

  it("non-array -> null", () => {
    expect(scorePhq9(undefined as unknown as number[])).toBeNull();
  });
});

describe("scoreGad7", () => {
  it.each([
    [seven(0), 0],
    [seven(1), 7],
    [seven(3), 21],
  ])("%j -> %i", (items, total) => expect(scoreGad7(items)).toBe(total));
  it.each([[[]], [[...seven(0), 0]], [[...seven(0).slice(1), 4]], [nine(0)]])(
    "invalid %j -> null",
    (items) => expect(scoreGad7(items)).toBeNull(),
  );
});

describe("phq9Item9", () => {
  it.each([0, 1, 2, 3])("returns item 9 = %i independently of the total", (v) => {
    expect(phq9Item9([3, 3, 3, 3, 3, 3, 3, 3, v])).toBe(v);
  });
  it("reads the ninth item, not the first", () => {
    expect(phq9Item9([3, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
  });
});

describe("bands", () => {
  it.each([
    [0, "minimal"],
    [4, "minimal"],
    [5, "mild"],
    [9, "mild"],
    [10, "moderate"],
    [14, "moderate"],
    [15, "moderately_severe"],
    [19, "moderately_severe"],
    [20, "severe"],
    [27, "severe"],
  ])("phq9Band(%i) = %s", (t, b) => expect(phq9Band(t)).toBe(b));
  it.each([-1, 28, 1.5, Number.NaN])("phq9Band(%s) = null", (t) => expect(phq9Band(t)).toBeNull());

  it.each([
    [0, "minimal"],
    [4, "minimal"],
    [5, "mild"],
    [9, "mild"],
    [10, "moderate"],
    [14, "moderate"],
    [15, "severe"],
    [21, "severe"],
  ])("gad7Band(%i) = %s", (t, b) => expect(gad7Band(t)).toBe(b));
  it.each([-1, 22, 2.5])("gad7Band(%s) = null", (t) => expect(gad7Band(t)).toBeNull());
});
