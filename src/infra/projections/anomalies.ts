import type { Db, StoredEvent } from "@/infra/event-store/types";

export type AnomalyCode =
  | "INVALID_EVENT"
  | "STREAM_RENEWAL_MISMATCH"
  | "AUDIT_ENTRY_MISSING"
  /** F060: a clinician did not concur with an auto-approval (visible alert on the admin pages). */
  | "RETRO_NON_CONCURRENCE";

/**
 * Record an event a projection refused to apply. Runs in the projection's transaction, so it
 * commits (or rolls back) with the batch. The runner's checkpoint still advances past the event:
 * a bad event is skipped and surfaced here instead of halting the whole read model. Idempotent
 * per (projection, position, code), so replays never duplicate rows.
 */
export async function recordAnomaly(
  tx: Db,
  projection: string,
  stored: StoredEvent,
  code: AnomalyCode,
  detail: string,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO projection_anomalies (projection, event_position, stream_id, event_type, code, detail)
     VALUES ($1, $2::bigint, $3, $4, $5, $6)
     ON CONFLICT (projection, event_position, code) DO NOTHING`,
    [
      projection,
      stored.globalPosition.toString(),
      stored.streamId,
      stored.type,
      code,
      detail.slice(0, 500),
    ],
  );
}

export async function listAnomalies(
  tx: Db,
  projection: string,
): Promise<{ position: bigint; streamId: string; eventType: string; code: string }[]> {
  const rows = await tx.unsafe<
    { event_position: string; stream_id: string; event_type: string; code: string }[]
  >(
    `SELECT event_position, stream_id, event_type, code FROM projection_anomalies
     WHERE projection = $1 ORDER BY event_position, code`,
    [projection],
  );
  return rows.map((r) => ({
    position: BigInt(r.event_position),
    streamId: r.stream_id,
    eventType: r.event_type,
    code: r.code,
  }));
}
