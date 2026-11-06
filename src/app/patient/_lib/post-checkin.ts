// Runs the renewal decision pipeline right after a check-in is saved (F036 wiring).
// The check-in is already durable when this runs. If evaluation throws, nothing is lost: the
// renewal stays open in renewal_queue (created at RenewalRequested, outcome null = unevaluated)
// and /api/cron/decisions (findPendingRenewals) evaluates it on its next run. The error is logged
// with a non-PHI code and the renewal id only, never the exception message or any answers.
import type { Sql } from "postgres";
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

/** Production deps from env. No ANTHROPIC key/model => AI result 'failed' => ESCALATE (fail closed). */
export function pipelineDepsFromEnv(): PipelineDeps {
  return { ai: riskDepsFromEnv(), refillLimit: loadConfig().REFILL_LIMIT };
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
