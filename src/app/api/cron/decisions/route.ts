import { riskDepsFromEnv } from "@/ai/fail-closed";
import { runPendingEvaluations } from "@/domain/pipeline/process-manager";
import { loadConfig } from "@/config";
import { getSql } from "@/infra/db/client";
import { isCronAuthorized } from "@/infra/outbox/cron-auth";

export const dynamic = "force-dynamic";

/**
 * Catch-up runner for the renewal decision process manager: evaluates renewals whose check-in is
 * in but that have no EligibilityEvaluated yet. The real LLM client exists only when
 * ANTHROPIC_API_KEY / ANTHROPIC_MODEL are set (riskDepsFromEnv); otherwise it fails closed and
 * renewals escalate. Missing CRON_SECRET => 401.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const stats = await runPendingEvaluations(getSql(), {
      ai: riskDepsFromEnv(),
      refillLimit: loadConfig().REFILL_LIMIT,
    });
    return Response.json({ ok: true, ...stats });
  } catch {
    return Response.json({ error: "pipeline_failed" }, { status: 500 });
  }
}
