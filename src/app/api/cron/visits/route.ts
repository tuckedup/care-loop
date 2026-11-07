import { repairUnfinishedSignings } from "@/domain/visit/handlers";
import { getSql } from "@/infra/db/client";
import { isCronAuthorized } from "@/infra/outbox/cron-auth";

export const dynamic = "force-dynamic";

/**
 * Repair sweep for visit-note signing: completes signed notes whose follow-up task is missing
 * (a crash between the two appends). Idempotent. Missing/invalid CRON_SECRET => 401 (fail closed).
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await repairUnfinishedSignings(getSql());
    return Response.json({
      ok: r.failed.length === 0 && r.missingSlot.length === 0,
      checked: r.checked,
      repaired: r.repaired.length,
      missingSlot: r.missingSlot.length,
      failed: r.failed.length,
    });
  } catch {
    return Response.json({ error: "repair_failed" }, { status: 500 });
  }
}
