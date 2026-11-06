import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "@/domain/rules";
import { baseInput } from "@/domain/rules/fixtures";
import type { RiskSignal } from "./types";
import { verifySignal, verifySignals } from "./verify-quotes";

const input = { freeText: "I feel hopeless lately. Maybe pregnant?", sideEffects: "dizzy" };
const sig = (o: Partial<RiskSignal> = {}): RiskSignal => ({
  type: "suicidal_ideation",
  quote: "hopeless",
  sourceField: "freeText",
  start: 7,
  end: 15,
  ...o,
});

describe("verifySignal", () => {
  it("accepts a quote at exactly [start,end) of the named field", () => {
    expect(verifySignal(sig(), input)).toMatchObject({ verified: true });
    expect(
      verifySignal(sig({ quote: "dizzy", sourceField: "sideEffects", start: 0, end: 5 }), input)
        .verified,
    ).toBe(true);
  });
  it("rejects shifted offsets even when the quote appears elsewhere in the text", () => {
    expect(verifySignal(sig({ start: 8, end: 16 }), input)).toMatchObject({
      verified: false,
      problem: "quote_mismatch",
    });
  });
  it("rejects a fabricated quote", () => {
    expect(verifySignal(sig({ quote: "hopeles5" }), input)).toMatchObject({
      verified: false,
      problem: "quote_mismatch",
    });
    expect(verifySignal(sig({ quote: "wants to die", start: 0, end: 12 }), input).verified).toBe(
      false,
    );
  });
  it("rejects the right text in the wrong field", () => {
    expect(verifySignal(sig({ sourceField: "sideEffects" }), input)).toMatchObject({
      verified: false,
      problem: "out_of_range",
    });
    expect(
      verifySignal(sig({ quote: "dizzy", start: 0, end: 5, sourceField: "freeText" }), input)
        .verified,
    ).toBe(false);
  });
  it("rejects out-of-range offsets and unknown fields", () => {
    expect(verifySignal(sig({ start: 30, end: 999 }), input).problem).toBe("out_of_range");
    expect(verifySignal({ ...sig(), sourceField: "constructor" as never }, input).problem).toBe(
      "unknown_field",
    );
  });
  it("is case and whitespace exact", () => {
    expect(verifySignal(sig({ quote: "Hopeless" }), input).verified).toBe(false);
    expect(verifySignal(sig({ quote: "hopeless " }), input).verified).toBe(false);
  });
});

describe("verifySignals", () => {
  it("never drops a failing signal and still escalates through R13", () => {
    const signals = [sig(), sig({ quote: "fabricated" })];
    const verified = verifySignals(signals, input);
    expect(verified).toHaveLength(2);
    expect(verified.map((v) => v.verified)).toEqual([true, false]);
    // Even a lone unverified signal reaches R13 as a signal => ESCALATE.
    const lone = verifySignals([sig({ quote: "fabricated" })], input);
    const r = evaluateEligibility(baseInput({ ai: { status: "ok", signals: lone } }));
    expect(r.outcome.type).toBe("ESCALATE");
    expect(r.reasonCodes).toContain("LLM_RISK_SIGNAL");
  });
});
