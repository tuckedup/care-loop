import { getSql } from "@/infra/db/client";
import { isCronAuthorized } from "@/infra/outbox/cron-auth";
import { createDefaultRegistry } from "@/infra/outbox/registry";
import { mulberry32 } from "@/infra/outbox/rng";
import { runOnce } from "@/infra/outbox/worker";

export const dynamic = "force-dynamic";

/** Vercel Cron calls GET with `Authorization: Bearer $CRON_SECRET`. Missing secret => 401. */
export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const seed = Number(process.env.SEED ?? 42);
    const stats = await runOnce(getSql(), {
      registry: createDefaultRegistry(),
      rng: mulberry32(Number.isFinite(seed) ? seed : 42),
    });
    return Response.json({ ok: true, ...stats });
  } catch {
    // Do not leak internals; the worker records per-message errors in the outbox itself.
    return Response.json({ error: "worker_failed" }, { status: 500 });
  }
}
