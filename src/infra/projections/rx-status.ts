import type { Db, StoredEvent } from "@/infra/event-store/types";
import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import { recordAnomaly } from "./anomalies";
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
  | "cancelled"
  | "cancel_requested"
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

/** Statuses that a decision or later pipeline step produced; progress events cannot undo them. */
const STICKY: ReadonlySet<RxStatusValue> = new Set([
  "approved",
  "denied",
  "follow_up_required",
  "queued",
  "transmitted",
  "pharmacy_status",
  "pharmacy_error",
  "filled",
  "cancelled",
  "cancel_requested",
]);

/** filled, cancelled, or a pharmacy error that is explicitly not retryable. */
export function isTerminalPharmacyOutcome(
  r: Pick<RxStatusRow, "status" | "pharmacyStatus">,
): boolean {
  if (r.status === "filled" || r.status === "cancelled") return true;
  return (
    r.status === "pharmacy_error" &&
    r.pharmacyStatus !== null &&
    r.pharmacyStatus.startsWith("ERROR:") &&
    !r.pharmacyStatus.endsWith(":retryable")
  );
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

  // Status precedence: once a decision (or anything after it) is on the row, evaluation and
  // review-progress events never downgrade it. Escalation may still move it back (fail safe).
  if (current !== null && STICKY.has(current.status)) {
    switch (event.type) {
      case "IdentityVerified":
      case "CheckInSubmitted":
      case "EligibilityEvaluated":
      case "ClinicianReviewStarted":
        return current;
      default:
    }
  }
  // Pharmacy outcome is terminal once it is a fill, a cancel acknowledgement or a FATAL (not
  // retryable) error. Late or duplicated pharmacy messages (a delayed Status after the fill, a
  // retryable error after a fatal one) never walk the row backwards. A fill still beats a fatal
  // error (the pharmacy did fill it), and a cancel acknowledgement beats everything.
  if (current !== null && isTerminalPharmacyOutcome(current)) {
    switch (event.type) {
      case "RxRenewalQueued":
      case "RxRenewalTransmitted":
      case "PharmacyStatusReceived":
      case "PharmacyErrorReceived":
        return current;
      case "RxFillReceived":
        if (current.status !== "pharmacy_error") return current;
        break;
      default:
    }
  }
  // Superseded by a newer approval: a CancelRx is on its way. Pharmacy progress does not walk the
  // row back; a fill (flagged elsewhere as an anomaly) or the cancel acknowledgement still apply.
  if (current !== null && current.status === "cancel_requested") {
    switch (event.type) {
      case "RxRenewalQueued":
      case "RxRenewalTransmitted":
      case "PharmacyStatusReceived":
      case "PharmacyErrorReceived":
        return current;
      default:
    }
  }
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
    case "RxCancelAcknowledged":
      return base("cancelled");
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
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      // A schema-invalid event is skipped and surfaced, never allowed to halt the projection.
      await recordAnomaly(tx, "rx_status", stored, "INVALID_EVENT", String(e));
      return;
    }
    // A newer renewal's approval supersedes earlier ones: mark each earlier row cancel_requested.
    if (event.type === "RxRenewalQueued") {
      for (const s of event.data.supersedes ?? []) {
        const [old] = await tx.unsafe<RxDbRow[]>(
          `SELECT * FROM rx_status WHERE renewal_id = $1 FOR UPDATE`,
          [s.renewalId],
        );
        if (!old) continue;
        const cur = toRxRow(old);
        if (cur.status === "filled" || cur.status === "cancelled") continue;
        await tx.unsafe(
          `UPDATE rx_status SET status = 'cancel_requested', last_event_type = $2,
                  last_position = $3::bigint, updated_at = $4::timestamptz WHERE renewal_id = $1`,
          [
            s.renewalId,
            event.type,
            stored.globalPosition.toString(),
            stored.createdAt.toISOString(),
          ],
        );
      }
    }
    const renewalId = renewalIdOf(event);
    if (renewalId === null) return;
    const [existing] = await tx.unsafe<RxDbRow[]>(
      `SELECT * FROM rx_status WHERE renewal_id = $1 FOR UPDATE`,
      [renewalId],
    );
    const current = existing ? toRxRow(existing) : null;
    // The patient must never be told "approved" or "denied" by a decision the clinician queue
    // refuses to honour: a decision on an escalated renewal with no ClinicianReviewStarted before it
    // (a system denial, a forged approval) leaves the patient status unchanged.
    if (event.type === "RenewalDenied" || event.type === "RenewalApproved") {
      const [facts] = await tx.unsafe<{ esc: boolean; rev: boolean }[]>(
        `SELECT
           EXISTS (SELECT 1 FROM events WHERE stream_id = $1 AND global_position < $2::bigint
                    AND (type = 'RenewalEscalated'
                         OR (type = 'EligibilityEvaluated' AND data->>'outcome' = 'ESCALATE'))) AS esc,
           EXISTS (SELECT 1 FROM events WHERE stream_id = $1 AND global_position < $2::bigint
                    AND type = 'ClinicianReviewStarted') AS rev`,
        [stored.streamId, stored.globalPosition.toString()],
      );
      if (facts?.esc && !facts.rev) return;
    }
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

/**
 * The rx_status row implied by ONE renewal stream's events, computed without the projection tables
 * (same reducer, same decision gating). Used for atomic checks inside a transaction, where the
 * projection may lag. Schema-invalid events are skipped, like the projection does.
 */
export function foldRxStatus(stored: readonly StoredEvent[]): RxStatusRow | null {
  let row: RxStatusRow | null = null;
  let escalated = false;
  let reviewed = false;
  for (const s of stored) {
    if (!KNOWN.has(s.type)) continue;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: s.type, data: s.data });
    } catch {
      continue;
    }
    if (event.type === "RenewalDenied" || event.type === "RenewalApproved") {
      if (escalated && !reviewed) continue; // the queue would not honour it either
    }
    if (
      event.type === "RenewalEscalated" ||
      (event.type === "EligibilityEvaluated" && event.data.outcome === "ESCALATE")
    ) {
      escalated = true;
    }
    if (event.type === "ClinicianReviewStarted") reviewed = true;
    const next = reduceRxStatus(row, event, {
      position: s.globalPosition,
      at: s.createdAt.toISOString(),
    });
    if (next !== null) row = next;
  }
  return row;
}

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
