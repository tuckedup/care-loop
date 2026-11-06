import { parseEvent } from "@/domain/events";
import { phq9Item9, scoreGad7, scorePhq9 } from "@/domain/rules/scoring";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import type { Projection } from "./runner";

export interface TrendPoint {
  renewalId: string;
  patientId: string;
  recordedAt: string; // ISO-8601, from the event
  phq9Total: number | null;
  gad7Total: number | null;
  item9: number | null;
  position: bigint;
}

/**
 * One point per submitted check-in. Totals come from the shared scoring functions; invalid
 * answers (cannot happen past Zod) would store null rather than a guess. The patient id is
 * read from the renewal stream's RenewalRequested event so this projection depends on no other.
 */
export const phq9TrendProjection: Projection = {
  name: "phq9_trend",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (stored.type !== "CheckInSubmitted") return;
    const event = parseEvent({ type: stored.type, data: stored.data });
    if (event.type !== "CheckInSubmitted") return;
    const d = event.data;
    const [req] = await tx.unsafe<{ data: { patientId?: string } }[]>(
      `SELECT data FROM events WHERE stream_id = $1 AND type = 'RenewalRequested'
       ORDER BY stream_version ASC LIMIT 1`,
      [stored.streamId],
    );
    const patientId = req?.data?.patientId;
    if (typeof patientId !== "string") return; // no known patient: nothing safe to attribute
    await tx.unsafe(
      `INSERT INTO phq9_trend (renewal_id, patient_id, recorded_at, phq9_total, gad7_total, item9, position)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7::bigint)
       ON CONFLICT (renewal_id) DO UPDATE SET
         recorded_at = EXCLUDED.recorded_at, phq9_total = EXCLUDED.phq9_total,
         gad7_total = EXCLUDED.gad7_total, item9 = EXCLUDED.item9, position = EXCLUDED.position`,
      [
        d.renewalId,
        patientId,
        stored.createdAt.toISOString(),
        scorePhq9(d.phq9),
        scoreGad7(d.gad7),
        phq9Item9(d.phq9),
        stored.globalPosition.toString(),
      ],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE phq9_trend`);
  },
};

interface Row {
  renewal_id: string;
  patient_id: string;
  recorded_at: string | Date;
  phq9_total: number | null;
  gad7_total: number | null;
  item9: number | null;
  position: string;
}

/** A patient's series, oldest first, ready for a sparkline. */
export async function getPhq9Trend(sql: Db, patientId: string): Promise<TrendPoint[]> {
  const rows = await sql.unsafe<Row[]>(
    `SELECT * FROM phq9_trend WHERE patient_id = $1 ORDER BY position ASC`,
    [patientId],
  );
  return rows.map((r) => ({
    renewalId: r.renewal_id,
    patientId: r.patient_id,
    recordedAt: (r.recorded_at instanceof Date
      ? r.recorded_at
      : new Date(String(r.recorded_at))
    ).toISOString(),
    phq9Total: r.phq9_total,
    gad7Total: r.gad7_total,
    item9: r.item9,
    position: BigInt(r.position),
  }));
}
