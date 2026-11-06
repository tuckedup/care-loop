import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import { renewalStreamId } from "@/domain/renewal/renewal";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

/** FHIR Task.status vocabulary, restricted to the three states the clinician queue shows. */
export type QueueStatus = "requested" | "in-progress" | "completed";
export type QueueDecision = "approved" | "denied" | "follow_up_required";

export interface RenewalQueueRow {
  renewalId: string;
  patientId: string;
  prescriptionId: string;
  status: QueueStatus;
  outcome: string | null;
  escalated: boolean;
  reasonCodes: string[];
  riskSignalCount: number;
  clinicianId: string | null;
  decision: QueueDecision | null;
  decidedBy: string | null;
  anomalies: string[];
  requestedAt: string;
  updatedAt: string;
  lastPosition: bigint;
  requestPosition: bigint;
}

/** Codes surfaced on the row when the event stream contradicts the safe path. */
export const QUEUE_ANOMALY = {
  SYSTEM_APPROVAL_ON_ESCALATED: "SYSTEM_APPROVAL_ON_ESCALATED",
  APPROVAL_WITHOUT_CLINICIAN_ID: "APPROVAL_WITHOUT_CLINICIAN_ID",
  DENIAL_WITHOUT_CLINICIAN_ON_ESCALATED: "DENIAL_WITHOUT_CLINICIAN_ON_ESCALATED",
  ESCALATED_AFTER_NON_CLINICIAN_DECISION: "ESCALATED_AFTER_NON_CLINICIAN_DECISION",
} as const;

/** An outcome of ESCALATE counts as escalated even if RenewalEscalated has not arrived (yet). */
export const isEscalated = (r: Pick<RenewalQueueRow, "escalated" | "outcome">) =>
  r.escalated || r.outcome === "ESCALATE";

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

/**
 * Pure reducer. Status rules:
 *  - requested: created, awaiting a decision (including escalated renewals waiting for a clinician)
 *  - in-progress: a clinician started review (first review start only)
 *  - completed: a valid decision was made, or the patient was sent to follow-up
 * Safety rules:
 *  - An escalated renewal completes as approved/denied ONLY with a clinician decision. For
 *    RenewalApproved that means by === "clinician" and a clinician id (on the event, else the
 *    one from ClinicianReviewStarted); RenewalDenied has no actor field, so it needs the
 *    clinician id from ClinicianReviewStarted. Otherwise the row stays open and gets an anomaly.
 *  - Terminal status blocks only status changes. Late escalation signals still set escalated,
 *    union the reason codes, and re-open a renewal that was completed WITHOUT a clinician.
 * Events for a renewal with no row are ignored (null stays null).
 */
export function reduceRenewalQueue(
  current: RenewalQueueRow | null,
  event: DomainEvent,
  meta: { position: bigint; at: string },
): RenewalQueueRow | null {
  if (event.type === "RenewalRequested") {
    if (current !== null) return current; // duplicate request: first one wins
    return {
      renewalId: event.data.renewalId,
      patientId: event.data.patientId,
      prescriptionId: event.data.prescriptionId,
      status: "requested",
      outcome: null,
      escalated: false,
      reasonCodes: [],
      riskSignalCount: 0,
      clinicianId: null,
      decision: null,
      decidedBy: null,
      anomalies: [],
      requestedAt: meta.at,
      updatedAt: meta.at,
      lastPosition: meta.position,
      requestPosition: meta.position,
    };
  }
  if (current === null) return current;
  const next = (over: Partial<RenewalQueueRow>): RenewalQueueRow => ({
    ...current,
    ...over,
    updatedAt: meta.at,
    lastPosition: meta.position,
  });
  const flag = (code: string) => union(current.anomalies, [code]);
  const done = current.status === "completed";

  /** Mark escalated; re-open a renewal that was completed without a clinician. */
  const escalate = (codes: readonly string[]): RenewalQueueRow => {
    const reopen =
      done &&
      (current.decision === "approved" || current.decision === "denied") &&
      current.decidedBy !== "clinician";
    return next({
      escalated: true,
      reasonCodes: union(current.reasonCodes, codes),
      ...(reopen
        ? {
            status: "requested" as const,
            decision: null,
            decidedBy: null,
            anomalies: flag(QUEUE_ANOMALY.ESCALATED_AFTER_NON_CLINICIAN_DECISION),
          }
        : {}),
    });
  };

  switch (event.type) {
    case "IdentityVerified":
    case "CheckInSubmitted":
      return done ? current : next({});
    case "RiskSignalsExtracted":
      return next({ riskSignalCount: event.data.signals.length });
    case "EligibilityEvaluated":
      return event.data.outcome === "ESCALATE"
        ? { ...escalate([]), outcome: event.data.outcome }
        : next({ outcome: event.data.outcome });
    case "RenewalEscalated":
      return escalate(event.data.reasonCodes);
    case "ClinicianReviewStarted":
      // A second review start never overwrites the clinician who already took the task.
      return current.status === "requested"
        ? next({ status: "in-progress", clinicianId: event.data.clinicianId })
        : current;
    case "RenewalApproved": {
      if (done) return current;
      const clinicianId = event.data.clinicianId ?? current.clinicianId;
      if (isEscalated(current)) {
        if (event.data.by !== "clinician") {
          return next({ anomalies: flag(QUEUE_ANOMALY.SYSTEM_APPROVAL_ON_ESCALATED) });
        }
        if (!clinicianId) {
          return next({ anomalies: flag(QUEUE_ANOMALY.APPROVAL_WITHOUT_CLINICIAN_ID) });
        }
      }
      return next({
        status: "completed",
        decision: "approved",
        decidedBy: event.data.by,
        clinicianId,
      });
    }
    case "RenewalDenied": {
      if (done) return current;
      if (isEscalated(current) && !current.clinicianId) {
        return next({ anomalies: flag(QUEUE_ANOMALY.DENIAL_WITHOUT_CLINICIAN_ON_ESCALATED) });
      }
      return next({
        status: "completed",
        decision: "denied",
        decidedBy: current.clinicianId ? "clinician" : "system",
      });
    }
    case "FollowUpRequired":
      // Completes the task but leaves escalated / reasonCodes untouched and visible.
      return done
        ? current
        : next({ status: "completed", decision: "follow_up_required", decidedBy: "system" });
    default:
      return current;
  }
}

interface Row {
  renewal_id: string;
  patient_id: string;
  prescription_id: string;
  status: QueueStatus;
  outcome: string | null;
  escalated: boolean;
  reason_codes: string[];
  risk_signal_count: number;
  clinician_id: string | null;
  decision: QueueDecision | null;
  decided_by: string | null;
  requested_at: string | Date;
  updated_at: string | Date;
  last_position: string;
  request_position: string;
  anomalies: string[];
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export function toQueueRow(r: Row): RenewalQueueRow {
  return {
    renewalId: r.renewal_id,
    patientId: r.patient_id,
    prescriptionId: r.prescription_id,
    status: r.status,
    outcome: r.outcome,
    escalated: r.escalated,
    reasonCodes: r.reason_codes,
    riskSignalCount: r.risk_signal_count,
    clinicianId: r.clinician_id,
    decision: r.decision,
    decidedBy: r.decided_by,
    anomalies: r.anomalies,
    requestedAt: iso(r.requested_at),
    updatedAt: iso(r.updated_at),
    lastPosition: BigInt(r.last_position),
    requestPosition: BigInt(r.request_position),
  };
}

const KNOWN = new Set<string>(EVENT_TYPES);
/** Event types the reducer acts on; only these are checked for stream/renewal id agreement. */
const QUEUE_TYPES = new Set<string>([
  "RenewalRequested",
  "IdentityVerified",
  "CheckInSubmitted",
  "RiskSignalsExtracted",
  "EligibilityEvaluated",
  "RenewalEscalated",
  "ClinicianReviewStarted",
  "RenewalApproved",
  "RenewalDenied",
  "FollowUpRequired",
]);

export const renewalQueueProjection: Projection = {
  name: "renewal_queue",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!KNOWN.has(stored.type) || !QUEUE_TYPES.has(stored.type)) return;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      // Skip and record; the runner checkpoint advances so one bad event cannot halt the queue.
      await recordAnomaly(tx, this.name, stored, "INVALID_EVENT", String(e));
      return;
    }
    const renewalId = (event.data as { renewalId?: string }).renewalId;
    if (typeof renewalId !== "string") return;
    if (stored.streamId !== renewalStreamId(renewalId)) {
      // Never let an event in one renewal's stream mutate another renewal's row.
      await recordAnomaly(
        tx,
        this.name,
        stored,
        "STREAM_RENEWAL_MISMATCH",
        `stream ${stored.streamId} carries renewalId ${renewalId}`,
      );
      return;
    }
    const [existing] = await tx.unsafe<Row[]>(
      `SELECT * FROM renewal_queue WHERE renewal_id = $1 FOR UPDATE`,
      [renewalId],
    );
    const current = existing ? toQueueRow(existing) : null;
    const next = reduceRenewalQueue(current, event, {
      position: stored.globalPosition,
      at: stored.createdAt.toISOString(),
    });
    if (next === null || next === current) return;
    await tx.unsafe(
      `INSERT INTO renewal_queue (renewal_id, patient_id, prescription_id, status, outcome,
          escalated, reason_codes, risk_signal_count, clinician_id, decision, decided_by,
          requested_at, updated_at, last_position, request_position, anomalies)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11,
               $12::timestamptz, $13::timestamptz, $14::bigint, $15::bigint, $16::text::jsonb)
       ON CONFLICT (renewal_id) DO UPDATE SET
         status = EXCLUDED.status, outcome = EXCLUDED.outcome, escalated = EXCLUDED.escalated,
         reason_codes = EXCLUDED.reason_codes, risk_signal_count = EXCLUDED.risk_signal_count,
         clinician_id = EXCLUDED.clinician_id, decision = EXCLUDED.decision,
         decided_by = EXCLUDED.decided_by, updated_at = EXCLUDED.updated_at,
         last_position = EXCLUDED.last_position, anomalies = EXCLUDED.anomalies`,
      [
        next.renewalId,
        next.patientId,
        next.prescriptionId,
        next.status,
        next.outcome,
        next.escalated,
        JSON.stringify(next.reasonCodes),
        next.riskSignalCount,
        next.clinicianId,
        next.decision,
        next.decidedBy,
        next.requestedAt,
        next.updatedAt,
        next.lastPosition.toString(),
        next.requestPosition.toString(),
        JSON.stringify(next.anomalies),
      ],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE renewal_queue`);
    await tx.unsafe(`DELETE FROM projection_anomalies WHERE projection = 'renewal_queue'`);
  },
};

/** Queue listing: escalated first, then oldest request, then immutable request position. */
export async function listRenewalQueue(
  sql: Db,
  opts: { status?: QueueStatus } = {},
): Promise<RenewalQueueRow[]> {
  const rows = opts.status
    ? await sql.unsafe<Row[]>(
        `SELECT * FROM renewal_queue WHERE status = $1 ORDER BY escalated DESC, requested_at ASC, request_position ASC`,
        [opts.status],
      )
    : await sql.unsafe<Row[]>(
        `SELECT * FROM renewal_queue ORDER BY escalated DESC, requested_at ASC, request_position ASC`,
      );
  return rows.map(toQueueRow);
}
