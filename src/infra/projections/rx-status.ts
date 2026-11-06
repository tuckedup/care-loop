import type { Db, StoredEvent } from "@/infra/event-store/types";
import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import type { Projection } from "./runner";

export type RxStatusValue =
  | "requested"
  | "identity_verified"
  | "checked_in"
  | "evaluated"
  | "escalated"
  | "in_review"
  | "approved"
  | "denied"
  | "queued"
  | "transmitted"
  | "pharmacy_status"
  | "pharmacy_error"
  | "filled"
  | "follow_up_required";

export interface RxStatusRow {
  renewalId: string;
  patientId: string;
  prescriptionId: string;
  status: RxStatusValue;
  /** Last pharmacy status string, if any (kept when later events change `status`). */
  pharmacyStatus: string | null;
  lastEventType: string;
  lastPosition: bigint;
  updatedAt: string; // ISO-8601, taken from the event, never from a clock
}

/**
 * Pure reducer: next row for a renewal given its current row and one event.
 * Latest event in global order wins. Events that do not describe renewal progress return the
 * input unchanged (null stays null).
 */
export function reduceRxStatus(
  current: RxStatusRow | null,
  event: DomainEvent,
  meta: { position: bigint; at: string },
): RxStatusRow | null {
  const base = (status: RxStatusValue, over: Partial<RxStatusRow> = {}): RxStatusRow | null =>
    current === null
      ? null
      : {
          ...current,
          status,
          lastEventType: event.type,
          lastPosition: meta.position,
          updatedAt: meta.at,
          ...over,
        };

  switch (event.type) {
    case "RenewalRequested":
      return {
        renewalId: event.data.renewalId,
        patientId: event.data.patientId,
        prescriptionId: event.data.prescriptionId,
        status: "requested",
        pharmacyStatus: null,
        lastEventType: event.type,
        lastPosition: meta.position,
        updatedAt: meta.at,
      };
    case "IdentityVerified":
      return base("identity_verified");
    case "CheckInSubmitted":
      return base("checked_in");
    case "EligibilityEvaluated":
      return base("evaluated");
    case "RenewalEscalated":
      return base("escalated");
    case "ClinicianReviewStarted":
      return base("in_review");
    case "RenewalApproved":
      return base("approved");
    case "RenewalDenied":
      return base("denied");
    case "RxRenewalQueued":
      return base("queued");
    case "RxRenewalTransmitted":
      return base("transmitted");
    case "PharmacyStatusReceived":
      return base("pharmacy_status", { pharmacyStatus: event.data.status });
    case "PharmacyErrorReceived":
      return base("pharmacy_error", {
        pharmacyStatus: `ERROR:${event.data.code}${event.data.retryable ? ":retryable" : ""}`,
      });
    case "RxFillReceived":
      return base("filled");
    case "FollowUpRequired":
      return base("follow_up_required");
    default:
      return current;
  }
}

interface RxDbRow {
  renewal_id: string;
  patient_id: string;
  prescription_id: string;
  status: RxStatusValue;
  pharmacy_status: string | null;
  last_event_type: string;
  last_position: string;
  updated_at: string | Date;
}

export function toRxRow(r: RxDbRow): RxStatusRow {
  return {
    renewalId: r.renewal_id,
    patientId: r.patient_id,
    prescriptionId: r.prescription_id,
    status: r.status,
    pharmacyStatus: r.pharmacy_status,
    lastEventType: r.last_event_type,
    lastPosition: BigInt(r.last_position),
    updatedAt: (r.updated_at instanceof Date
      ? r.updated_at
      : new Date(String(r.updated_at))
    ).toISOString(),
  };
}

const KNOWN = new Set<string>(EVENT_TYPES);

/** The renewal id an event belongs to, or null for events outside the renewal flow. */
function renewalIdOf(event: DomainEvent): string | null {
  const data = event.data as { renewalId?: string };
  return typeof data.renewalId === "string" ? data.renewalId : null;
}

export const rxStatusProjection: Projection = {
  name: "rx_status",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!KNOWN.has(stored.type)) return;
    const event = parseEvent({ type: stored.type, data: stored.data });
    const renewalId = renewalIdOf(event);
    if (renewalId === null) return;
    const [existing] = await tx.unsafe<RxDbRow[]>(
      `SELECT * FROM rx_status WHERE renewal_id = $1 FOR UPDATE`,
      [renewalId],
    );
    const current = existing ? toRxRow(existing) : null;
    const next = reduceRxStatus(current, event, {
      position: stored.globalPosition,
      at: stored.createdAt.toISOString(),
    });
    if (next === null || next === current) return;
    await tx.unsafe(
      `INSERT INTO rx_status (renewal_id, patient_id, prescription_id, status, pharmacy_status,
                              last_event_type, last_position, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::timestamptz)
       ON CONFLICT (renewal_id) DO UPDATE SET
         status = EXCLUDED.status, pharmacy_status = EXCLUDED.pharmacy_status,
         last_event_type = EXCLUDED.last_event_type, last_position = EXCLUDED.last_position,
         updated_at = EXCLUDED.updated_at`,
      [
        next.renewalId,
        next.patientId,
        next.prescriptionId,
        next.status,
        next.pharmacyStatus,
        next.lastEventType,
        next.lastPosition.toString(),
        next.updatedAt,
      ],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE rx_status`);
  },
};

export async function getRxStatus(sql: Db, renewalId: string): Promise<RxStatusRow | null> {
  const [row] = await sql.unsafe<RxDbRow[]>(`SELECT * FROM rx_status WHERE renewal_id = $1`, [
    renewalId,
  ]);
  return row ? toRxRow(row) : null;
}

export async function listRxStatusForPatient(sql: Db, patientId: string): Promise<RxStatusRow[]> {
  const rows = await sql.unsafe<RxDbRow[]>(
    `SELECT * FROM rx_status WHERE patient_id = $1 ORDER BY last_position ASC`,
    [patientId],
  );
  return rows.map(toRxRow);
}
