// Runs the renewal decision pipeline right after a check-in is saved (F036 wiring).
// The check-in is already durable when this runs. If evaluation throws, nothing is lost: the
// renewal stays open in renewal_queue (created at RenewalRequested, outcome null = unevaluated)
// and /api/cron/decisions (findPendingRenewals) evaluates it on its next run. The error is logged
// with a non-PHI code and the renewal id only, never the exception message or any answers.
import type { Sql } from "postgres";
import { createRecordedClient } from "@/ai/client";
import { riskDepsFromEnv } from "@/ai/fail-closed";
import { loadConfig } from "@/config";
import {
  evaluateRenewal,
  type PipelineDeps,
  type PipelineResult,
} from "@/domain/pipeline/process-manager";

export const PIPELINE_EVALUATION_FAILED = "PIPELINE_EVALUATION_FAILED";

export type PostCheckInResult =
  { ok: true; result: PipelineResult } | { ok: false; code: typeof PIPELINE_EVALUATION_FAILED };

/**
 * HAND-WRITTEN e2e fixture model (synthetic-handwritten), used only when RISK_FIXTURE is set AND
 * NODE_ENV is exactly "development" or "test" (same gate as SUMMARY_FIXTURE). It answers "no
 * signals" so end-to-end specs can reach rule outcomes that LLM_FAILURE escalation would shadow
 * (e.g. R06 follow-up). It cannot approve anything: the local tripwire and injection scans still
 * run, every other rule still applies, and the result is never an approval. Production
 * (NODE_ENV=production) ignores the variable and keeps failing closed without a key.
 */
export function riskFixtureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env.RISK_FIXTURE === "synthetic-handwritten" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test")
  );
}

/** Production deps from env. No ANTHROPIC key/model => AI result 'failed' => ESCALATE (fail closed). */
export function pipelineDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PipelineDeps {
  const refillLimit = loadConfig().REFILL_LIMIT;
  if (riskFixtureEnabled(env)) {
    return {
      ai: {
        client: createRecordedClient(() => '{"signals":[]}'),
        model: "synthetic-handwritten-fixture",
      },
      refillLimit,
    };
  }
  return { ai: riskDepsFromEnv(), refillLimit };
}

/** Never throws. `deps` is injectable for tests; production passes nothing. */
export async function evaluateAfterCheckIn(
  sql: Sql,
  renewalId: string,
  deps?: PipelineDeps,
  log: (line: string) => void = (l) => console.error(l),
): Promise<PostCheckInResult> {
  try {
    return {
      ok: true,
      result: await evaluateRenewal(sql, renewalId, deps ?? pipelineDepsFromEnv()),
    };
  } catch {
    log(
      `[pipeline] ${PIPELINE_EVALUATION_FAILED} renewal=${renewalId} (catch-up: /api/cron/decisions)`,
    );
    return { ok: false, code: PIPELINE_EVALUATION_FAILED };
  }
}
