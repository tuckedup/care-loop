// pharmacy, keyed by (renewal, pharmacy messageId): a duplicate message is one row, a reused id elsewhere is not hidden.
//   - PharmacistEscalationReceived          -> kind "escalation"
//   - PharmacyErrorReceived (not retryable) -> kind "error"   (retryable errors retry, no alert)
//   - RxCancelAcknowledged                  -> kind "cancel"
// PharmacyAlertAcknowledged marks a row acknowledged. Deterministic: only event data and the
// event store are read, so a rebuild equals the incremental result.
import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

export type AlertKind = "escalation" | "error" | "cancel";
export interface PharmacyAlert {
  messageId: string;
  renewalId: string;
  patientId: string | null;
  kind: AlertKind;
  code: string | null;
  message: string;
  raisedAt: string;
  status: "open" | "acknowledged";
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

const KNOWN = new Set<string>(EVENT_TYPES);
const RELEVANT = new Set([
  "PharmacistEscalationReceived",
  "PharmacyErrorReceived",
  "RxCancelAcknowledged",
  "PharmacyAlertAcknowledged",
]);

/** Plain-language alert text for the codes this system raises itself; otherwise the pharmacy's. */
function errorMessage(code: string): string {
  if (code === "TRANSMIT_DEAD_LETTERED") {
    return "The prescription could not be sent to the pharmacy (delivery gave up or was refused). The patient has been told there was a problem.";
  }
  if (code === "STALLED_NO_FILL") {
    return "The pharmacy accepted the prescription but no fill has been reported within the expected time. Please check with the pharmacy.";
  }
  return `Pharmacy rejected the renewal (${code}); it will not be retried.`;
}

async function patientOf(tx: Db, streamId: string): Promise<string | null> {
  const [row] = await tx.unsafe<{ pid: string | null }[]>(
    `SELECT data->>'patientId' AS pid FROM events
     WHERE stream_id = $1 AND type = 'RenewalRequested' ORDER BY stream_version LIMIT 1`,
    [streamId],
  );
  return row?.pid ?? null;
}

async function raise(
  tx: Db,
  stored: StoredEvent,
  a: {
    messageId: string;
    renewalId: string;
    kind: AlertKind;
    code: string | null;
    message: string;
  },
) {
  await tx.unsafe(
    `INSERT INTO pharmacy_alerts (message_id, renewal_id, patient_id, kind, code, message,
                                  raised_at, raised_position)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::bigint)
     ON CONFLICT (renewal_id, message_id) DO NOTHING`,
    [
      a.messageId,
      a.renewalId,
      await patientOf(tx, stored.streamId),
      a.kind,
      a.code,
      a.message,
      stored.createdAt.toISOString(),
      stored.globalPosition.toString(),
    ],
  );
}

export const pharmacyAlertsProjection: Projection = {
  name: "pharmacy_alerts",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!KNOWN.has(stored.type) || !RELEVANT.has(stored.type)) return;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      await recordAnomaly(tx, "pharmacy_alerts", stored, "INVALID_EVENT", String(e));
      return;
    }
    switch (event.type) {
      case "PharmacistEscalationReceived":
        await raise(tx, stored, {
          messageId: event.data.messageId,
          renewalId: event.data.renewalId,
          kind: "escalation",
          code: null,
          message: event.data.message,
        });
        return;
      case "PharmacyErrorReceived":
        if (event.data.retryable) return;
        await raise(tx, stored, {
          messageId: event.data.messageId,
          renewalId: event.data.renewalId,
          kind: "error",
          code: event.data.code,
          message: errorMessage(event.data.code),
        });
        return;
      case "RxCancelAcknowledged":
        await raise(tx, stored, {
          messageId: event.data.messageId,
          renewalId: event.data.renewalId,
          kind: "cancel",
          code: null,
          message: "The pharmacy acknowledged a cancellation of this prescription.",
        });
        return;
      case "PharmacyAlertAcknowledged":
        await tx.unsafe(
          `UPDATE pharmacy_alerts SET status = 'acknowledged', acknowledged_by = $2,
                  acknowledged_at = $3::timestamptz
           WHERE message_id = $1 AND renewal_id = $4 AND status = 'open'`,
          [
            event.data.messageId,
            event.data.acknowledgedBy,
            stored.createdAt.toISOString(),
            event.data.renewalId,
          ],
        );
        return;
      default:
    }
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE pharmacy_alerts`);
  },
};

interface AlertRow {
  message_id: string;
  renewal_id: string;
  patient_id: string | null;
  kind: AlertKind;
  code: string | null;
  message: string;
  raised_at: string | Date;
  status: "open" | "acknowledged";
  acknowledged_by: string | null;
  acknowledged_at: string | Date | null;
}
const iso = (d: string | Date) => (d instanceof Date ? d : new Date(String(d))).toISOString();

export async function listPharmacyAlerts(
  sql: Db,
  opts: { status?: "open" | "acknowledged" } = {},
): Promise<PharmacyAlert[]> {
  const rows = opts.status
    ? await sql.unsafe<AlertRow[]>(
        `SELECT * FROM pharmacy_alerts WHERE status = $1 ORDER BY raised_position ASC`,
        [opts.status],
      )
    : await sql.unsafe<AlertRow[]>(
        `SELECT * FROM pharmacy_alerts ORDER BY (status = 'open') DESC, raised_position ASC`,
      );
  return rows.map((r) => ({
    messageId: r.message_id,
    renewalId: r.renewal_id,
    patientId: r.patient_id,
    kind: r.kind,
    code: r.code,
    message: r.message,
    raisedAt: iso(r.raised_at),
    status: r.status,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: r.acknowledged_at ? iso(r.acknowledged_at) : null,
  }));
}
