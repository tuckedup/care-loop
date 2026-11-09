// Repeated live-model run: `pnpm eval:live:repeat` (EVAL_REPEATS trials per case, default 3).
// Measures what one pass cannot: run-to-run consistency (pass^k), uncertainty (Wilson and clustered
// standard errors), over-escalation and the model failure rate. Informational: it is not the gate
// and never writes latest.json or live-latest.json. Synthetic cases only.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAiConfig } from "../src/ai/config";
import { runAiStage } from "./ai-runner";
import { loadCases, runCase } from "./lib";
import { clusteredSe, mean, passHatK } from "./stats";
import { wilsonInterval } from "./wilson";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = (model: string) =>
  join(here, "results", `live-repeat.${model.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const CONCURRENCY = 4;

interface Trial {
  caseId: string;
  category: string;
  trial: number;
  expected: string;
  actual: string;
  aiStatus: string;
  blocked: boolean;
  calls: number;
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: size }, worker));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (k: number, n: number) => {
  const w = wilsonInterval(k, n);
  return `${k}/${n} (95% Wilson ${w.low.toFixed(3)} to ${w.high.toFixed(3)})`;
};

async function main() {
  const cfg = loadAiConfig();
  if (!cfg.apiKey || !cfg.model) {
    throw new Error("live-repeat needs ANTHROPIC_API_KEY and ANTHROPIC_MODEL; nothing was run");
  }
  const k = Number(process.env.EVAL_REPEATS ?? "3");
  if (!Number.isInteger(k) || k < 2 || k > 10) throw new Error("EVAL_REPEATS must be 2 to 10");

  const jobs: { c: ReturnType<typeof loadCases>[number]; trial: number }[] = [];
  for (const c of loadCases()) {
    if (!c.aiFixture) continue;
    for (let trial = 0; trial < k; trial++) jobs.push({ c, trial });
  }
  const trials: Trial[] = [];
  await pool(jobs, CONCURRENCY, async ({ c, trial }) => {
    const stage = await runAiStage(c, true);
    if (stage.skipped) return;
    const res = runCase(c, stage.ai, { live: true });
    trials.push({
      caseId: c.id,
      category: c.category,
      trial,
      expected: c.expected.outcome,
      actual: res.actualOutcome,
      aiStatus: stage.obs.status,
      blocked: stage.blocked,
      calls: stage.calls,
    });
  });

  const byCase = new Map<string, Trial[]>();
  for (const t of trials) byCase.set(t.caseId, [...(byCase.get(t.caseId) ?? []), t]);
  const cases = [...byCase.values()];
  const esc = cases.filter((ts) => ts[0]!.expected === "ESCALATE");
  const escTrials = esc.flat();
  const escHits = escTrials.filter((t) => t.actual === "ESCALATE");
  const perCaseHits = esc.map((ts) => ts.filter((t) => t.actual === "ESCALATE").length);
  const passK = mean(perCaseHits.map((c) => passHatK(k, c, k)));
  const nonEsc = cases.filter((ts) => !["ESCALATE", "REJECT"].includes(ts[0]!.expected)).flat();
  const over = nonEsc.filter((t) => t.actual === "ESCALATE");
  const unsafe = trials.filter(
    (t) => ["ESCALATE", "REJECT"].includes(t.expected) && t.actual === "AUTO_ELIGIBLE",
  );
  const modelTrials = trials.filter((t) => !t.blocked);
  const modelFailed = modelTrials.filter((t) => t.aiStatus === "failed");
  const flaky = cases
    .filter(
      (ts) =>
        new Set(ts.map((t) => t.actual)).size > 1 || new Set(ts.map((t) => t.aiStatus)).size > 1,
    )
    .map((ts) => ts[0]!.caseId);
  const se = clusteredSe(
    escTrials.map((t) => (t.actual === "ESCALATE" ? 1 : 0)),
    escTrials.map((t) => t.category),
  );
  const blockedCalls = trials.filter((t) => t.blocked).reduce((a, t) => a + t.calls, 0);

  const out = {
    kind: "live-repeat",
    generatedBy: "evals/live-repeat.ts",
    date: new Date().toISOString().slice(0, 10),
    provider: "anthropic",
    model: cfg.model,
    repeats: k,
    cases: cases.length,
    trials: trials.length,
    escalation: {
      cases: esc.length,
      trials: escTrials.length,
      trialRecall: escHits.length / escTrials.length,
      trialRecallWilson: wilsonInterval(escHits.length, escTrials.length),
      clusteredSe: se,
      passHatK: passK,
      casesAllTrialsEscalated: perCaseHits.filter((c) => c === k).length,
      missedTrials: escTrials.filter((t) => t.actual !== "ESCALATE").map((t) => t.caseId),
    },
    unsafeApprovalTrials: unsafe.length,
    overEscalation: { trials: nonEsc.length, escalated: over.length },
    modelFailure: { trials: modelTrials.length, failed: modelFailed.length },
    blockedModelCalls: blockedCalls,
    flakyCases: flaky,
  };
  const OUT = outPath(cfg.model);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  console.log(
    `model ${cfg.model}, ${k} trials per case, ${cases.length} cases, ${trials.length} trials`,
  );
  console.log(
    `escalation recall (trials): ${ci(escHits.length, escTrials.length)}, clustered SE ${se.toFixed(4)}`,
  );
  console.log(
    `pass^${k} over ${esc.length} escalation cases: ${pct(passK)} (${out.escalation.casesAllTrialsEscalated} escalated in all ${k} trials)`,
  );
  console.log(
    `unsafe approvals: ${unsafe.length}; controlled-substance model calls: ${blockedCalls}`,
  );
  console.log(`over-escalation: ${ci(over.length, nonEsc.length)}`);
  console.log(
    `model call failed (fell back to escalation): ${ci(modelFailed.length, modelTrials.length)}`,
  );
  console.log(
    `cases with inconsistent behaviour across trials: ${flaky.length} ${flaky.slice(0, 8).join(", ")}`,
  );
  if (out.escalation.missedTrials.length > 0) process.exitCode = 1;
  if (unsafe.length > 0 || blockedCalls > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String((e as Error).message));
  process.exitCode = 1;
});
