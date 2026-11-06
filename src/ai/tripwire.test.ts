import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "@/domain/rules";
import { baseInput } from "@/domain/rules/fixtures";
import { createRecordedClient } from "./client";
import { runRiskExtraction, toRulesAiResult } from "./fail-closed";
import { detectTripwire } from "./tripwire";

const detect = (freeText: string, sideEffects = "") => detectTripwire({ freeText, sideEffects });

const RISKY = [
  "I want to die",
  "I WANT TO DIE",
  "thinking about suicide",
  "I am feeling suicidal",
  "I could kill myself",
  "kill my self",
  "I want to end my life",
  "ending my own life",
  "maybe I should just end it all",
  "no reason to live",
  "I don't want to live anymore",
  "I dont want to live",
  "I don’t want to live",
  "everyone would be better off dead",
  "I have been cutting myself",
  "thoughts of self-harm",
  "self harm again",
  "I took an overdose",
  "afraid I might overdose",
  "I am dying inside",
  "I want to kill him",
  "I might hurt someone",
  "harm other people",
];

describe("detectTripwire", () => {
  it.each(RISKY)("flags %j with an exact span of the ORIGINAL text", (t) => {
    const text = `Fine otherwise. ${t}. Thanks.`;
    const sigs = detect(text);
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) {
      expect(text.slice(s.start, s.end)).toBe(s.quote);
      expect(s.verified).toBe(true);
      expect(s.origin).toBe("tripwire");
    }
  });

  it("matches through case, accents, spacing and look-alike letters, reporting original offsets", () => {
    const text = "prefix  SUΙCіDE?  x"; // Greek capital iota, Cyrillic i
    const t2 = "so I  wаnt   tо   dіe later"; // Cyrillic a, o, i; extra spaces
    for (const t of [text, t2, "I wänt to dïe", "I want to d​ie"]) {
      const sigs = detect(t);
      expect(sigs.length, t).toBeGreaterThan(0);
      for (const s of sigs) expect(t.slice(s.start, s.end)).toBe(s.quote);
    }
    const sp = detect("so I   KILL    MYSELF  now");
    expect(sp[0]?.quote).toBe("KILL    MYSELF");
  });

  it("scans the side-effects field too", () => {
    expect(detect("fine", "I want to die")[0]?.sourceField).toBe("sideEffects");
  });

  it("does not flag ordinary text", () => {
    for (const t of [
      "Feeling good, same dose.",
      "My phone died on the way here.",
      "I dyed my hair and slept well.",
      "Mild nausea after the pills, nothing severe.",
      "The pharmacy was out of stock.",
    ]) {
      expect(detect(t), t).toEqual([]);
    }
  });

  it("is linear on pathological input", () => {
    const t0 = Date.now();
    detect("\n".repeat(100_000));
    detect(" ".repeat(100_000) + "die");
    detect("kill ".repeat(20_000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("tripwire through runRiskExtraction", () => {
  const run = async (modelOutput: string, freeText: string) => {
    const client = createRecordedClient(() => modelOutput);
    const r = await runRiskExtraction(
      baseInput(),
      { freeText, sideEffects: "" },
      {
        client,
        model: "m",
      },
    );
    return { r, out: evaluateEligibility(baseInput({ ai: toRulesAiResult(r) })), client };
  };

  it("a silent model cannot hide 'I want to die': ESCALATE with LLM_RISK_SIGNAL", async () => {
    const { r, out } = await run('{"signals":[]}', "Honestly I want to die some days.");
    expect(r.status === "ok" && r.signals.some((s) => s.origin === "tripwire")).toBe(true);
    expect(out.outcome.type).toBe("ESCALATE");
    expect(out.reasonCodes).toContain("LLM_RISK_SIGNAL");
  });

  it("still runs when the model call fails and is attached for diagnostics", async () => {
    const { r, out } = await run("not json", "I want to die");
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.localSignals?.[0]?.type).toBe("suicidal_ideation");
    expect(out.outcome.type).toBe("ESCALATE");
    const none = await runRiskExtraction(
      baseInput(),
      { freeText: "I want to die", sideEffects: "" },
      { client: null, model: "m" },
    );
    expect(none.status === "failed" && none.localSignals?.length).toBeGreaterThan(0);
  });

  it("model and tripwire signals on the same span are not duplicated", async () => {
    const text = "I want to die";
    const model = JSON.stringify({
      signals: [
        { type: "suicidal_ideation", quote: "die", sourceField: "freeText", start: 10, end: 13 },
      ],
    });
    const { r } = await run(model, text);
    expect(
      r.status === "ok" && r.signals.filter((s) => s.start === 10 && s.end === 13),
    ).toHaveLength(1);
  });
});
