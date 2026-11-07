import { riskDepsFromEnv } from "@/ai/fail-closed";
import { runPendingEvaluations } from "@/domain/pipeline/process-manager";
import { loadConfig } from "@/config";
import { getSql } from "@/infra/db/client";
import { isCronAuthorized } from "@/infra/outbox/cron-auth";

import { enforceRateLimit, LIMITS } from "@/infra/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Catch-up runner for the renewal decision process manager: evaluates renewals whose check-in is
 * in but that have no EligibilityEvaluated yet. The real LLM client exists only when
 * ANTHROPIC_API_KEY / ANTHROPIC_MODEL are set (riskDepsFromEnv); otherwise it fails closed and
 * renewals escalate. Missing CRON_SECRET => 401.
 */
export async function GET(request: Request): Promise<Response> {
  // Per-instance best-effort throttle, applied before the secret check to slow guessing.
  const limited = enforceRateLimit(request, "cron-decisions", LIMITS.cron);
  if (limited) return limited;
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const stats = await runPendingEvaluations(getSql(), {
      ai: riskDepsFromEnv(),
      refillLimit: loadConfig().REFILL_LIMIT,
    });
    // failedIds are opaque renewal ids (no PHI); failures were escalated or logged, never silent.
    return Response.json({ ok: stats.failed === 0, ...stats });
  } catch {
    return Response.json({ error: "pipeline_failed" }, { status: 500 });
  }
}
