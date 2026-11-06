import { describe, expect, it } from "vitest";
import { ALLOWLISTED_DRUGS } from "../formulary";
import { evaluateEligibility } from "./evaluate";
import { baseInput } from "./fixtures";
import { ruleM01 } from "./medication-identity";
import { isAiPathAllowed } from "./r03-controlled";
import { ruleR06 } from "./r06-refill-limit";
import { scoreGad7, scorePhq9 } from "./scoring";
import type { RuleInput } from "./types";

const withName = (name: string, rxcui = "4493", formularyId: string | null = null): RuleInput => {
  const b = baseInput();
  return {
    ...b,
    medication: { ...b.medication, name, rxcui, formularyId },
    activeOrder: { status: "active", intent: "order", rxcui },
  };
};
const outcome = (i: RuleInput) => evaluateEligibility(i).outcome.type;

// Hostile suffixes appended to a real drug name. None is a drug list used by the product:
// they only prove that ANY unexplained word next to the drug name escalates.
const HOSTILE_SUFFIXES = [
  "alprazolam",
  "alprazolem",
  "alprazol am",
  "alpraz​olam",
  "аlprazolam", // Cyrillic a
  "alprazolаm",
  "xanax",
  "(xanаx)",
  "xana x",
  "clonazepam",
  "klonopin",
  "lorazepam",
  "ativan",
  "diazepam",
  "valium",
  "oxycodone",
  "oxycontin",
  "percocet",
  "hydrocodone",
  "morphine",
  "fentanyl",
  "adderall",
  "amphetamine",
  "dextroamphetamine",
  "methylphenidate",
  "ritalin",
  "concerta",
  "zolpidem",
  "ambien",
  "tramadol",
  "lisdexamfetamine",
  "vyvanse",
  "temazepam",
  "phenobarbital",
  "codeine",
  "ketamine",
  "lithium",
  "quetiapine",
  "sertraline",
  "paroxetine",
  "x",
  "unknown",
  "plus",
  "and alprazolam",
  "/alprazolam",
  "+ clonazepam",
  "'; drop table",
  "\u0000alprazolam",
  "‮alprazolam", // right-to-left override
  "⁣alprazolam", // invisible separator then drug
  "alpräzolam",
  "\u{1F48A}", // pill emoji
];

describe("M01 inverted check: unexplained words in the medication name escalate", () => {
  const prefixes = ["fluoxetine", "FLUOXETINE", "  fluoxetine  ", "fluoxetine 20 mg"];

  it("no hostile name is AUTO_ELIGIBLE on the fluoxetine RxCUI (prefix and suffix positions)", () => {
    let n = 0;
    for (const s of HOSTILE_SUFFIXES)
      for (const p of prefixes) {
        for (const name of [`${p} ${s}`, `${s} ${p}`, `${p}${s}`]) {
          n++;
          expect(outcome(withName(name)), JSON.stringify(name)).not.toBe("AUTO_ELIGIBLE");
        }
      }
    expect(n).toBeGreaterThan(500);
  });

  it("the same hostile suffixes cannot ride on any allowlisted RxCUI", () => {
    for (const d of ALLOWLISTED_DRUGS) {
      for (const s of HOSTILE_SUFFIXES.filter((x) => !d.aliases.includes(x))) {
        const r = outcome(withName(`${d.name} ${s}`, d.rxcui!, d.id));
        expect(r, `${d.name} ${s}`).not.toBe("AUTO_ELIGIBLE");
      }
    }
  });

  it.each([
    "fluoxetine clonazepam",
    "fluoxetine lorazepam",
    "fluoxetine diazepam",
    "fluoxetine oxycodone",
    "fluoxetine adderall",
    "fluoxetine ativan",
    "fluoxetine klonopin",
    "fluoxetine zolpidem",
    "fluoxetine tramadol",
    "fluoxetine ritalin",
    "fluoxetine methylphenidate",
    "fluoxetine alprazolem",
    "fluoxetine аlprazolam",
    "fluoxetine (xanаx)",
    "fluоxetine",
  ])("%j escalates with MEDICATION_IDENTITY_MISMATCH", (name) => {
    const r = evaluateEligibility(withName(name));
    expect(r.outcome.type).toBe("ESCALATE");
    expect(r.reasonCodes).toContain("MEDICATION_IDENTITY_MISMATCH");
  });

  it("non-ASCII letters left after normalisation escalate even without other words", () => {
    expect(ruleM01(withName("flυoxetine")).passed).toBe(false); // Greek upsilon
    expect(ruleM01(withName("fluoxetine 中")).passed).toBe(false);
  });

  it("a controlled name that survives as a hard signal still blocks the AI path", () => {
    expect(isAiPathAllowed(withName("fluoxetine alprazolam"))).toBe(false);
    expect(isAiPathAllowed(withName("fluoxetine (xanax)"))).toBe(false);
  });

  it.each([
    ["sertraline", "36437"],
    ["sertraline 50 mg tablet", "36437"],
    ["Sertraline HCl 100mg tablets", "36437"],
    ["bupropion SR 150 mg", "42347"],
    ["bupropion XL 300 mg", "42347"],
    ["venlafaxine ER capsule", "39786"],
    ["Venlafaxine extended-release capsules 75 mg", "39786"],
    ["fluoxetine", "4493"],
    ["escitalopram 10 mg", "321988"],
    ["citalopram 20 mg", "2556"],
    ["desvenlafaxine ER 50 mg", "734064"],
  ])("positive control %j can still be AUTO_ELIGIBLE", (name, rxcui) => {
    // desvenlafaxine ER: an ER word on a non-form-specific entry escalates by design (M02)
    const expected = name.startsWith("desvenlafaxine ER") ? "ESCALATE" : "AUTO_ELIGIBLE";
    expect(outcome(withName(name, rxcui))).toBe(expected);
  });
});

describe("sparse and malformed PHQ-9 / GAD-7 arrays", () => {
  const sparsePhq = [, , , , , , , , 0] as unknown as number[];
  const sparseGad = new Array<number>(7);

  it("scoring rejects holes", () => {
    expect(scorePhq9(sparsePhq)).toBeNull();
    expect(scoreGad7(sparseGad)).toBeNull();
    expect(scorePhq9(new Array<number>(9))).toBeNull();
  });

  it("holes never reach AUTO_ELIGIBLE and escalate with INVALID_INPUT", () => {
    for (const checkIn of [
      { ...baseInput().checkIn, phq9: sparsePhq },
      { ...baseInput().checkIn, gad7: sparseGad },
    ]) {
      const r = evaluateEligibility({ ...baseInput(), checkIn });
      expect(r.outcome.type).toBe("ESCALATE");
      expect(r.reasonCodes).toContain("INVALID_INPUT");
    }
  });
});

describe("refillLimit has no upper bound (accepted risk)", () => {
  // TODO: source needed. SPEC gives no maximum for REFILL_LIMIT, so none is invented here.
  // A huge limit effectively disables R06. Validating the config value is out of scope for the
  // rules (loadConfig-style callers own it). Recorded in the ADR-003 note.
  it.each([1e308, Number.MAX_SAFE_INTEGER])(
    "limit %s passes R06 (documented behaviour)",
    (limit) => {
      expect(ruleR06(baseInput({ renewalsSinceLastVisit: 1000, refillLimit: limit })).passed).toBe(
        true,
      );
    },
  );
  it("non-finite limits still fail closed", () => {
    expect(ruleR06(baseInput({ refillLimit: Infinity })).passed).toBe(false);
  });
});

describe("TOCTOU: evaluation uses one snapshot of the input", () => {
  it("a getter that flips from null to 'IV' is rejected (fail closed), never approved", () => {
    const b = baseInput();
    let reads = 0;
    Object.defineProperty(b.medication, "controlledSchedule", {
      get() {
        return reads++ < 3 ? null : "IV";
      },
      enumerable: true,
    });
    const r = evaluateEligibility(b);
    expect(r.outcome).toEqual({ type: "ESCALATE", reasons: ["INVALID_INPUT"] });
  });

  it("every getter on any level, however benign, is rejected", () => {
    const b = baseInput();
    Object.defineProperty(b, "refillLimit", { get: () => 2, enumerable: true });
    expect(evaluateEligibility(b).outcome).toEqual({
      type: "ESCALATE",
      reasons: ["INVALID_INPUT"],
    });
  });

  it("a lying proxy over phq9 cannot show item 9 = 0 to the rules", () => {
    const real = [0, 0, 0, 0, 0, 0, 0, 0, 1];
    let reads = 0;
    const lying = new Proxy(real, {
      get(t, k, r) {
        // first reads look clean, later reads reveal the truth
        if (k === "8" && reads++ < 100) return 0;
        return Reflect.get(t, k, r);
      },
    });
    const b = baseInput();
    const r = evaluateEligibility({ ...b, checkIn: { ...b.checkIn, phq9: lying } });
    expect(r.outcome.type).toBe("ESCALATE");
  });

  it("a proxy with a lying descriptor trap is read once and stays consistent", () => {
    let reads = 0;
    const real = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const p = new Proxy(real, {
      getOwnPropertyDescriptor(t, k) {
        const d = Reflect.getOwnPropertyDescriptor(t, k);
        if (k === "8" && d) return { ...d, value: reads++ === 0 ? 0 : 3 };
        return d;
      },
    });
    const b = baseInput();
    const r = evaluateEligibility({ ...b, checkIn: { ...b.checkIn, phq9: p } });
    // only the first (clean) read is ever used, so all rules agree with each other
    expect(reads).toBeLessThanOrEqual(1);
    expect(
      r.results.filter((x) => x.ruleId === "R07" || x.ruleId === "R08").every((x) => x.passed),
    ).toBe(true);
  });

  it("functions, symbols, class instances and __proto__ keys fail closed", () => {
    const bad: unknown[] = [
      { ...baseInput(), identityVerified: () => true },
      { ...baseInput(), extra: Symbol("s") },
      { ...baseInput(), extra: new Date(0) },
      { ...baseInput(), extra: new Map() },
      JSON.parse('{"__proto__":{"identityVerified":true},"medication":{},"checkIn":{}}'),
      Proxy.revocable({}, {}).proxy,
    ];
    for (const x of bad) {
      expect(evaluateEligibility(x as RuleInput).outcome.type, String(x)).toBe("ESCALATE");
    }
    const revoked = Proxy.revocable(baseInput(), {});
    revoked.revoke();
    expect(evaluateEligibility(revoked.proxy).outcome).toEqual({
      type: "ESCALATE",
      reasons: ["INVALID_INPUT"],
    });
  });

  it("deeply nested or cyclic input fails closed", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(
      evaluateEligibility({ ...baseInput(), ai: { status: "ok", signals: [cyc] } }).outcome,
    ).toEqual({
      type: "ESCALATE",
      reasons: ["INVALID_INPUT"],
    });
  });

  it("the caller's object is not mutated and frozen input is fine", () => {
    const b = Object.freeze(baseInput());
    expect(evaluateEligibility(b).outcome.type).toBe("AUTO_ELIGIBLE");
  });
});
