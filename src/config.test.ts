import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("applies defaults from the spec (REFILL_LIMIT=2)", () => {
    const cfg = loadConfig({});
    expect(cfg.REFILL_LIMIT).toBe(2);
    expect(cfg.SAMPLE_RATE).toBeGreaterThanOrEqual(0);
    expect(cfg.SAMPLE_RATE).toBeLessThanOrEqual(1);
  });

  it("coerces numeric env strings", () => {
    expect(loadConfig({ REFILL_LIMIT: "3", SAMPLE_RATE: "0.5", SEED: "7" })).toMatchObject({
      REFILL_LIMIT: 3,
      SAMPLE_RATE: 0.5,
      SEED: 7,
    });
  });

  it("treats empty strings as unset", () => {
    const cfg = loadConfig({ REFILL_LIMIT: "", SAMPLE_RATE: "", ANTHROPIC_MODEL: "" });
    expect(cfg.REFILL_LIMIT).toBe(2);
    expect(cfg.SAMPLE_RATE).toBe(0.2);
    expect(cfg.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("rejects an out-of-range SAMPLE_RATE", () => {
    expect(() => loadConfig({ SAMPLE_RATE: "1.5" })).toThrow();
  });
});
