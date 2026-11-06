import { parseEvent, type DomainEvent } from "@/domain/events";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { phq9Item9, scoreGad7, scorePhq9 } from "@/domain/rules/scoring";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

export interface TrendPoint {
  renewalId: string;
  patientId: string | null;
  orphan: boolean;
  recordedAt: string; // ISO-8601, from the event
  phq9Total: number | null;
  gad7Total: number | null;
  item9: number | null;
  position: bigint;
}

/**
 * One point per submitted check-in, keyed by (renewal id, event position) so a second check-in
 * never overwrites the first. Totals come from the shared scoring functions. The patient id is
 * read from the renewal stream's RenewalRequested event so this projection depends on no other.
 * A check-in with no RenewalRequested is NOT dropped: it is stored with patient_id NULL and
 * orphan = true (never shown in a patient's series), and repaired when the request event is
 * applied or on rebuild. Events whose stream does not match their renewalId are skipped and
 * recorded in projection_anomalies; schema-invalid events likewise (checkpoint still advances).
 */
export const phq9TrendProjection: Projection = {
  name: "phq9_trend",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (stored.type !== "CheckInSubmitted" && stored.type !== "RenewalRequested") return;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      await recordAnomaly(tx, "phq9_trend", stored, "INVALID_EVENT", String(e));
      return;
    }
    if (event.type !== "CheckInSubmitted" && event.type !== "RenewalRequested") return;
    const renewalId = event.data.renewalId;
    if (stored.streamId !== renewalStreamId(renewalId)) {
      await recordAnomaly(
        tx,
        "phq9_trend",
        stored,
        "STREAM_RENEWAL_MISMATCH",
        `stream ${stored.streamId} carries renewalId ${renewalId}`,
      );
      return;
    }
    if (event.type === "RenewalRequested") {
      await tx.unsafe(
        `UPDATE phq9_trend SET patient_id = $2, orphan = false WHERE renewal_id = $1 AND orphan`,
        [renewalId, event.data.patientId],
      );
      return;
    }
    const d = event.data;
    const [req] = await tx.unsafe<{ data: { patientId?: string } }[]>(
      `SELECT data FROM events WHERE stream_id = $1 AND type = 'RenewalRequested'
       ORDER BY stream_version ASC LIMIT 1`,
      [stored.streamId],
    );
    const patientId = typeof req?.data?.patientId === "string" ? req.data.patientId : null;
    await tx.unsafe(
      `INSERT INTO phq9_trend (renewal_id, position, patient_id, orphan, recorded_at, phq9_total,
                               gad7_total, item9)
       VALUES ($1, $2::bigint, $3, $4, $5::timestamptz, $6, $7, $8)
       ON CONFLICT (renewal_id, position) DO NOTHING`,
      [
        d.renewalId,
        stored.globalPosition.toString(),
        patientId,
        patientId === null,
        stored.createdAt.toISOString(),
        scorePhq9(d.phq9),
        scoreGad7(d.gad7),
        phq9Item9(d.phq9),
      ],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE phq9_trend`);
    await tx.unsafe(`DELETE FROM projection_anomalies WHERE projection = 'phq9_trend'`);
  },
};

interface Row {
  renewal_id: string;
  patient_id: string | null;
  orphan: boolean;
  recorded_at: string | Date;
  phq9_total: number | null;
  gad7_total: number | null;
  item9: number | null;
  position: string;
}

/** A patient's series, oldest first, ready for a sparkline. */
export async function getPhq9Trend(sql: Db, patientId: string): Promise<TrendPoint[]> {
  const rows = await sql.unsafe<Row[]>(
    `SELECT * FROM phq9_trend WHERE patient_id = $1 AND NOT orphan ORDER BY position ASC`,
    [patientId],
  );
  return rows.map((r) => ({
    renewalId: r.renewal_id,
    patientId: r.patient_id,
    orphan: r.orphan,
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
