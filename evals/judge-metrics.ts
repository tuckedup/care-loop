// CREOLA-style summary-judge metrics and their gate. No imports of other eval modules, so
// evals/lib.ts can use it without a cycle. See src/ai/judge.ts and evals/judge-eval.ts.
import type { JudgeFailureReason } from "../src/ai/judge";

/** Ratchet: the judge case set may only grow. */
export const MIN_JUDGE_CASES = 12;

export interface JudgeCaseOutcome {
  id: string;
  status: "judged" | "judge_failed";
  reason?: JudgeFailureReason;
  /** Summary lines the upstream filter (uncited / unknown id / deny-list) removed before judging. */
  droppedUpstream: number;
  linesJudged: number;
  hallucination: { major: number; minor: number };
  omission: { major: number; minor: number };
  /** true when the status, dropped count, line verdicts and omissions equal the hand label. */
  matchesLabel: boolean;
}

export interface JudgeEvalMetrics {
  /**
   * Where the verdicts came from. "fixture-judge-synthetic-handwritten": hand-written canned judge
   * responses, NOT a live judge. "live-judge": a real model produced the verdicts.
   */
  labelSource: "fixture-judge-synthetic-handwritten" | "live-judge";
  /** true ONLY for `pnpm eval:live`. */
  liveJudgeRun: boolean;
  promptVersion: string;
  cases: number;
  judged: number;
  /** Judgments that failed. Counted separately: a failed judgment is never reported as good. */
  judgeFailed: number;
  /** Cases whose hand label says the judge must fail closed. */
  expectedJudgeFailed: number;
  unexpectedJudgeFailures: string[];
  /** Cases whose judged result differs from the hand label. */
  labelMismatches: string[];
  linesJudged: number;
  linesDroppedUpstream: number;
  hallucination: { major: number; minor: number };
  omission: { major: number; minor: number };
  /** Judged cases with no hallucination and no omission. */
  cleanCases: number;
  casesWithMajorFinding: number;
  perCase: JudgeCaseOutcome[];
}

/** Gate for the judge section. Empty = pass. Fails closed when nothing meaningful ran. */
export function judgeGateFailures(m: JudgeEvalMetrics | null): string[] {
  if (m === null) return ["summary judge section was not computed"];
  const f: string[] = [];
  if (m.cases < MIN_JUDGE_CASES) {
    f.push(`only ${m.cases} judge cases ran; at least ${MIN_JUDGE_CASES} required`);
  }
  if (m.labelMismatches.length > 0) {
    f.push(`judge cases not matching labels: ${m.labelMismatches.join(", ")}`);
  }
  if (m.unexpectedJudgeFailures.length > 0) {
    f.push(`unexpected judge_failed: ${m.unexpectedJudgeFailures.join(", ")}`);
  }
  if (m.judged + m.judgeFailed !== m.cases) f.push("judge case accounting does not add up");
  if (!m.liveJudgeRun) {
    // The fail-closed path and the hard summary failures must be exercised, or nothing was checked.
    if (m.expectedJudgeFailed < 3) {
      f.push(`only ${m.expectedJudgeFailed} judge fail-closed case(s); at least 3 required`);
    }
    if (m.hallucination.major < 1) f.push("no major hallucination case exercised");
    if (m.omission.major < 1) f.push("no major omission case exercised");
    if (m.linesDroppedUpstream < 1) f.push("no upstream-dropped (uncited or stale) line exercised");
  }
  return f;
}
