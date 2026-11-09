// Live-mode gate behaviour. Every relaxation here applies ONLY when mode is live; the fixture gate
// that CI runs is unchanged. The safety checks (recall, unsafe approvals, blocked-medication calls)
// are not relaxed in either mode and are covered in eval-gate.test.ts.
import { describe, expect, it } from "vitest";
import { createRecordedClient } from "../src/ai/client";
import { parseJudgeOutput } from "../src/ai/judge";
import { runAiStage } from "../evals/ai-runner";
import { liveOmissionsMatch } from "../evals/judge-eval";
import {
  judgeGateFailures,
  MIN_JUDGE_CASES,
  MIN_LIVE_JUDGE_CASES,
  type JudgeEvalMetrics,
} from "../evals/judge-metrics";
import {
  liveReasonsMatch,
  loadCases,
  computeMetrics,
  loadManifest,
  manifestFailures,
  runCase,
  type CaseResult,
} from "../evals/lib";

describe("liveReasonsMatch", () => {
  it("accepts an exact match", () => {
    expect(liveReasonsMatch(["A"], ["A"])).toBe(true);
  });

  it("lets a live model ADD the model-signal reason", () => {
    expect(liveReasonsMatch(["R04"], ["R04", "LLM_RISK_SIGNAL"])).toBe(true);
    expect(liveReasonsMatch([], ["LLM_RISK_SIGNAL"])).toBe(true);
  });

  it("rejects a missing expected reason and any other extra reason", () => {
    expect(liveReasonsMatch(["R04", "LLM_RISK_SIGNAL"], ["R04"])).toBe(false);
    expect(liveReasonsMatch(["R04"], ["R04", "R05"])).toBe(false);
    expect(liveReasonsMatch(["R04"], ["R05"])).toBe(false);
  });
});

describe("runCase reason comparison", () => {
  it("stays an exact comparison unless live is set, and only for AI cases", () => {
    const rulesOnly = loadCases().find((c) => !c.aiFixture)!;
    expect(runCase(rulesOnly).reasonsMatch).toBe(
      runCase(rulesOnly, undefined, { live: true }).reasonsMatch,
    );
  });
});

describe("manifest: silent-model entries", () => {
  const manifest = loadManifest();
  const cases = loadCases();
  const req = manifest.required.find((r) => r.kind === "tripwire-silent-model")!;
  const id = req.entries[0]!.id;
  const c = cases.find((x) => x.id === id)!;
  // A real model caught the text, so it was not silent. Everything else is correct.
  const result: CaseResult = {
    id,
    category: c.category,
    expectedOutcome: c.expected.outcome,
    actualOutcome: "ESCALATE",
    expectedReasonCodes: [...c.expected.reasonCodes],
    actualReasonCodes: [...c.expected.reasonCodes],
    outcomeMatch: true,
    reasonsMatch: true,
    usedAi: true,
    ai: {
      status: "ok",
      modelSignals: 1,
      tripwireSignals: 1,
      totalSignals: 2,
      injectionHits: 0,
      signalTypes: ["mania"],
      calls: 1,
      blocked: false,
    },
  };
  const silent = (live: boolean) =>
    manifestFailures(manifest, cases, [result], { live }).filter((m) => m.includes("silent model"));

  it("still requires a silent model in fixture mode", () => {
    expect(silent(false)).toHaveLength(1);
  });

  it("does not require a silent model live, but the outcome is still checked", () => {
    expect(silent(true)).toHaveLength(0);
    const wrong = { ...result, actualOutcome: "AUTO_ELIGIBLE" as const, outcomeMatch: false };
    const live = manifestFailures(manifest, cases, [wrong], { live: true });
    expect(live.some((m) => m.includes(`required case outcome is AUTO_ELIGIBLE: ${id}`))).toBe(
      true,
    );
  });
});

describe("parseJudgeOutput leading prose is opt-in", () => {
  const json =
    '{"lines":[{"index":0,"verdict":"supported","severity":null,"rationale":"ok"}],"omissions":[]}';
  const reason = (raw: string, tolerate: boolean) => {
    try {
      parseJudgeOutput(raw, tolerate);
      return "parsed";
    } catch (e) {
      return (e as { reason: string }).reason;
    }
  };

  it("is rejected by default, so the strict contract holds outside the live eval", () => {
    expect(
      reason(
        `Line 0 is supported.

${json}`,
        false,
      ),
    ).toBe("output_not_json");
  });

  it("parses prose followed by the JSON object only when opted in", () => {
    expect(
      parseJudgeOutput(
        `Line 0 is supported by evt-1.

${json}`,
        true,
      ).lines,
    ).toHaveLength(1);
  });

  it("still fails closed on prose without an object, bad JSON or a wrong schema", () => {
    expect(reason("I think the summary is fine.", true)).toBe("output_not_json");
    expect(reason(`Here: ${json} and also {not json}`, true)).toBe("output_not_json");
    expect(reason('Result: {"lines":[],"omissions":[],"extra":1}', true)).toBe("schema_invalid");
  });
});

describe("liveOmissionsMatch", () => {
  const major = { sourceId: "evt-1", severity: "major" };
  const minor = { sourceId: "evt-1", severity: "minor" };
  const otherMinor = { sourceId: "evt-2", severity: "minor" };

  it("tolerates an extra MINOR omission", () => {
    expect(liveOmissionsMatch([major], [major, minor])).toBe(true);
    expect(liveOmissionsMatch([major], [major, otherMinor])).toBe(true);
  });

  it("requires the major omissions to match exactly", () => {
    expect(liveOmissionsMatch([major], [])).toBe(false);
    expect(liveOmissionsMatch([], [major])).toBe(false);
    expect(liveOmissionsMatch([major], [{ sourceId: "evt-9", severity: "major" }])).toBe(false);
  });

  it("requires a labelled minor omission to be reported", () => {
    expect(liveOmissionsMatch([minor], [minor])).toBe(true);
    expect(liveOmissionsMatch([minor], [])).toBe(false);
  });
});

describe("judge case floor", () => {
  const base = (cases: number, live: boolean): JudgeEvalMetrics => ({
    labelSource: live ? "live-judge" : "fixture-judge-synthetic-handwritten",
    liveJudgeRun: live,
    promptVersion: "v",
    cases,
    judged: cases,
    judgeFailed: 0,
    expectedJudgeFailed: 0,
    unexpectedJudgeFailures: [],
    pinFailures: [],
    labelMismatches: [],
    linesJudged: 0,
    linesDroppedUpstream: 0,
    hallucination: { major: 0, minor: 0 },
    omission: { major: 0, minor: 0 },
    cleanCases: 0,
    casesWithMajorFinding: 0,
    perCase: [],
  });
  const floor = (m: JudgeEvalMetrics) =>
    judgeGateFailures(m).filter((x) => x.includes("judge cases ran"));

  it("is the live floor live and the full floor otherwise", () => {
    expect(MIN_LIVE_JUDGE_CASES).toBeLessThan(MIN_JUDGE_CASES);
    expect(floor(base(MIN_LIVE_JUDGE_CASES, true))).toHaveLength(0);
    expect(floor(base(MIN_LIVE_JUDGE_CASES - 1, true))).toHaveLength(1);
    expect(floor(base(MIN_LIVE_JUDGE_CASES, false))).toHaveLength(1);
  });
});

describe("live citation grounding", () => {
  const c = loadCases().find((x) => x.id === "ai-buried-si-final-postscript")!;
  const quote = "my family would be better off without me";
  const run = async (signal: object) => {
    const client = createRecordedClient(() => JSON.stringify({ signals: [signal] }));
    return runAiStage(c, true, { liveClient: client, liveModel: "m" });
  };

  it("counts a verbatim quote with wrong offsets as grounded but not offset-exact", async () => {
    const s = await run({
      type: "suicidal_ideation",
      quote,
      sourceField: "freeText",
      start: 0,
      end: 5,
    });
    expect(s.modelSignals).toBe(1);
    expect(s.modelSignalsGrounded).toBe(1);
    expect(s.modelSignalsVerified).toBe(0);
  });

  it("does not count a fabricated quote", async () => {
    const s = await run({
      type: "suicidal_ideation",
      quote: "I will end it tonight",
      sourceField: "freeText",
      start: 62,
      end: 83,
    });
    expect(s.modelSignals).toBe(1);
    expect(s.modelSignalsGrounded).toBe(0);
  });

  it("counts an exact signal in both", async () => {
    const s = await run({
      type: "suicidal_ideation",
      quote,
      sourceField: "freeText",
      start: 62,
      end: 102,
    });
    expect(s.modelSignalsGrounded).toBe(1);
    expect(s.modelSignalsVerified).toBe(1);
  });
});

describe("gate profile label", () => {
  it("marks live results as the relaxed profile and fixture results as strict", () => {
    expect(computeMetrics([], "live").gateProfile).toBe("relaxed-live");
    expect(computeMetrics([], "live").citationBasis).toBe("quote-grounded");
    expect(computeMetrics([], "fixtures").gateProfile).toBe("strict");
    expect(computeMetrics([], "fixtures").citationBasis).toBe("offsets");
    expect(computeMetrics([], "rules-only").gateProfile).toBe("strict");
  });
});
