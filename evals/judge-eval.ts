// CREOLA-style summary-judge eval (F067). EVAL-ONLY code; product code never imports it.
// A judge case holds hand-written summary lines (what a summariser emitted, including uncited or
// stale ones), the source texts, a judge fixture, and a HAND LABEL for the expected judgment.
// The upstream filter of the product (filterCitedLines) runs first, then the judge sees only the
// surviving lines. In CI the judge is a recorded client over hand-written fixtures
// (evals/fixtures/judge/*, synthetic-handwritten): the verdicts are fixture judgments, not a live
// judge. `pnpm eval:live` uses the real API for the judge only; it is implemented but UNTESTED.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAnthropicClient, createRecordedClient, type RiskLlmClient } from "../src/ai/client";
import { loadAiConfig } from "../src/ai/config";
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_SEVERITIES,
  JUDGE_VERDICTS,
  judgeSummary,
  type JudgeFailureReason,
  type JudgeResult,
} from "../src/ai/judge";
import { filterCitedLines } from "../src/ai/summarize";
import { AiFixtureSchema, type AiFixture } from "./fixtures";
import type { JudgeCaseOutcome, JudgeEvalMetrics } from "./judge-metrics";

const here = dirname(fileURLToPath(import.meta.url));
/** Judge cases and fixtures are deliberately NOT subject to the EVAL_* path overrides. */
export const judgeCasesDir = () => join(here, "judge-cases");
export const judgeFixturesDir = () => join(here, "fixtures", "judge");

const Severity = z.enum(JUDGE_SEVERITIES);
const FAILURE_REASONS = [
  "no_client",
  "model_not_configured",
  "empty_input",
  "input_too_large",
  "timeout",
  "llm_error",
  "output_not_json",
  "schema_invalid",
  "inconsistent_verdicts",
] as const satisfies readonly JudgeFailureReason[];

export const JudgeCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    scenario: z.string().min(1),
    /** How the HAND LABEL below was derived (from the source texts, never from judge output). */
    labeledFrom: z.string().min(15),
    sources: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict()).min(1),
    /** Lines as a summariser emitted them, before the upstream filter. sourceId may be absent. */
    rawSummary: z
      .array(z.object({ text: z.string().min(1), sourceId: z.string().optional() }).strict())
      .min(1),
    escalated: z.boolean(),
    /** File name (without .json) in evals/fixtures/judge/. */
    judgeFixture: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    expected: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("judged"),
          droppedUpstream: z.number().int().min(0),
          lines: z.array(
            z.object({ verdict: z.enum(JUDGE_VERDICTS), severity: Severity.nullable() }).strict(),
          ),
          omissions: z.array(z.object({ sourceId: z.string(), severity: Severity }).strict()),
        })
        .strict(),
      z
        .object({
          status: z.literal("judge_failed"),
          droppedUpstream: z.number().int().min(0),
          reason: z.enum(FAILURE_REASONS),
        })
        .strict(),
    ]),
  })
  .strict();
export type JudgeCase = z.infer<typeof JudgeCaseSchema>;

export function loadJudgeCases(dir: string = judgeCasesDir()): JudgeCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error(`judge eval: zero judge cases in ${dir}`);
  const seen = new Set<string>();
  return files.sort().map((f) => {
    const parsed = JudgeCaseSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`invalid judge case ${f}: ${parsed.error.message}`);
    if (f !== `${parsed.data.id}.json`) throw new Error(`judge case file ${f} must be <id>.json`);
    if (seen.has(parsed.data.id)) throw new Error(`duplicate judge case id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    return parsed.data;
  });
}

export function loadJudgeFixture(name: string, dir: string = judgeFixturesDir()): AiFixture {
  const parsed = AiFixtureSchema.safeParse(
    JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")),
  );
  if (!parsed.success) throw new Error(`invalid judge fixture ${name}: ${parsed.error.message}`);
  return parsed.data;
}

const NEVER = () => new Promise<string>(() => {});

export interface JudgeRunOptions {
  /** Test seam for the live client. */
  liveClient?: RiskLlmClient | null;
  liveModel?: string;
}

export interface JudgeCaseRun {
  outcome: JudgeCaseOutcome;
  result: JudgeResult;
  skipped: boolean;
}

function matchesLabel(c: JudgeCase, dropped: number, r: JudgeResult): boolean {
  const e = c.expected;
  if (dropped !== e.droppedUpstream) return false;
  if (e.status === "judge_failed") return r.status === "judge_failed" && r.reason === e.reason;
  if (r.status !== "judged") return false;
  if (r.lines.length !== e.lines.length) return false;
  if (
    !r.lines.every(
      (l, i) => l.verdict === e.lines[i]?.verdict && l.severity === e.lines[i]?.severity,
    )
  ) {
    return false;
  }
  const key = (o: { sourceId: string; severity: string }) => `${o.sourceId}|${o.severity}`;
  const got = r.omissions.map(key).sort();
  const want = e.omissions.map(key).sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

export async function runJudgeCase(
  c: JudgeCase,
  live: boolean,
  opts: JudgeRunOptions = {},
): Promise<JudgeCaseRun> {
  const fixture = loadJudgeFixture(c.judgeFixture);
  const allowed = new Set(c.sources.map((s) => s.id));
  // The product's own upstream filter: uncited, unknown-id (stale) and deny-listed lines go here.
  const { lines, dropped } = filterCitedLines(c.rawSummary, allowed, { escalated: c.escalated });

  let client: RiskLlmClient | null;
  let model: string | undefined;
  let timeoutMs: number;
  if (live) {
    const cfg = loadAiConfig();
    model = opts.liveModel ?? cfg.model;
    client =
      opts.liveClient !== undefined
        ? opts.liveClient
        : cfg.apiKey
          ? createAnthropicClient({ apiKey: cfg.apiKey })
          : null;
    timeoutMs = 60_000;
  } else {
    model = "fixture-judge";
    timeoutMs = 50;
    client = createRecordedClient(() => {
      const r = fixture.response;
      if (r.type === "text") return r.text;
      if (r.error === "http_500") throw new Error("500 Internal Server Error (fixture)");
      return NEVER();
    });
  }
  const result = await judgeSummary({ sources: c.sources, lines }, { client, model, timeoutMs });
  const hall = { major: 0, minor: 0 };
  const omis = { major: 0, minor: 0 };
  if (result.status === "judged") {
    for (const l of result.lines)
      if (l.verdict === "hallucination" && l.severity) hall[l.severity] += 1;
    for (const o of result.omissions) omis[o.severity] += 1;
  }
  return {
    result,
    skipped: live && !fixture.header.liveApplicable,
    outcome: {
      id: c.id,
      status: result.status,
      ...(result.status === "judge_failed" ? { reason: result.reason } : {}),
      droppedUpstream: dropped,
      linesJudged: result.status === "judged" ? result.lines.length : 0,
      hallucination: hall,
      omission: omis,
      matchesLabel: matchesLabel(c, dropped, result),
    },
  };
}

/** Runs every judge case and aggregates the metrics written into latest.json. */
export async function runJudgeEval(
  live: boolean,
  opts: JudgeRunOptions = {},
  dir: string = judgeCasesDir(),
): Promise<JudgeEvalMetrics> {
  const cases = loadJudgeCases(dir);
  const runs: { c: JudgeCase; run: JudgeCaseRun }[] = [];
  for (const c of cases) {
    const run = await runJudgeCase(c, live, opts);
    if (!run.skipped) runs.push({ c, run });
  }
  const m: JudgeEvalMetrics = {
    labelSource: live ? "live-judge" : "fixture-judge-synthetic-handwritten",
    liveJudgeRun: live,
    promptVersion: JUDGE_PROMPT_VERSION,
    cases: runs.length,
    judged: 0,
    judgeFailed: 0,
    expectedJudgeFailed: 0,
    unexpectedJudgeFailures: [],
    labelMismatches: [],
    linesJudged: 0,
    linesDroppedUpstream: 0,
    hallucination: { major: 0, minor: 0 },
    omission: { major: 0, minor: 0 },
    cleanCases: 0,
    casesWithMajorFinding: 0,
    perCase: [],
  };
  for (const { c, run } of runs) {
    const o = run.outcome;
    m.perCase.push(o);
    if (c.expected.status === "judge_failed") m.expectedJudgeFailed += 1;
    if (o.status === "judge_failed") {
      m.judgeFailed += 1;
      if (c.expected.status !== "judge_failed") m.unexpectedJudgeFailures.push(c.id);
    } else {
      m.judged += 1;
      m.linesJudged += o.linesJudged;
      m.hallucination.major += o.hallucination.major;
      m.hallucination.minor += o.hallucination.minor;
      m.omission.major += o.omission.major;
      m.omission.minor += o.omission.minor;
      const findings =
        o.hallucination.major + o.hallucination.minor + o.omission.major + o.omission.minor;
      if (findings === 0) m.cleanCases += 1;
      if (o.hallucination.major + o.omission.major > 0) m.casesWithMajorFinding += 1;
    }
    m.linesDroppedUpstream += o.droppedUpstream;
    if (!o.matchesLabel) m.labelMismatches.push(c.id);
  }
  return m;
}
