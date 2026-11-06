import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import type { Db, StoredEvent } from "@/infra/event-store/types";
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
  requestedAt: string;
  updatedAt: string;
  lastPosition: bigint;
}

/**
 * Pure reducer. Status rules:
 *  - requested: created, awaiting a decision (including escalated renewals waiting for a clinician)
 *  - in-progress: a clinician started review
 *  - completed: approved, denied, or sent to follow-up; terminal, later events never reopen it
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
      requestedAt: meta.at,
      updatedAt: meta.at,
      lastPosition: meta.position,
    };
  }
  if (current === null || current.status === "completed") return current;
  const next = (over: Partial<RenewalQueueRow>): RenewalQueueRow => ({
    ...current,
    ...over,
    updatedAt: meta.at,
    lastPosition: meta.position,
  });
  switch (event.type) {
    case "IdentityVerified":
    case "CheckInSubmitted":
      return next({});
    case "RiskSignalsExtracted":
      return next({ riskSignalCount: event.data.signals.length });
    case "EligibilityEvaluated":
      return next({ outcome: event.data.outcome });
    case "RenewalEscalated":
      return next({ escalated: true, reasonCodes: [...event.data.reasonCodes] });
    case "ClinicianReviewStarted":
      return next({ status: "in-progress", clinicianId: event.data.clinicianId });
    case "RenewalApproved":
      return next({
        status: "completed",
        decision: "approved",
        decidedBy: event.data.by,
        clinicianId: event.data.clinicianId ?? current.clinicianId,
      });
    case "RenewalDenied":
      return next({ status: "completed", decision: "denied", decidedBy: "clinician" });
    case "FollowUpRequired":
      return next({ status: "completed", decision: "follow_up_required", decidedBy: "system" });
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
    requestedAt: iso(r.requested_at),
    updatedAt: iso(r.updated_at),
    lastPosition: BigInt(r.last_position),
  };
}

const KNOWN = new Set<string>(EVENT_TYPES);

export const renewalQueueProjection: Projection = {
  name: "renewal_queue",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!KNOWN.has(stored.type)) return;
    const event = parseEvent({ type: stored.type, data: stored.data });
    const renewalId = (event.data as { renewalId?: string }).renewalId;
    if (typeof renewalId !== "string") return;
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
          requested_at, updated_at, last_position)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11,
               $12::timestamptz, $13::timestamptz, $14::bigint)
       ON CONFLICT (renewal_id) DO UPDATE SET
         status = EXCLUDED.status, outcome = EXCLUDED.outcome, escalated = EXCLUDED.escalated,
         reason_codes = EXCLUDED.reason_codes, risk_signal_count = EXCLUDED.risk_signal_count,
         clinician_id = EXCLUDED.clinician_id, decision = EXCLUDED.decision,
         decided_by = EXCLUDED.decided_by, updated_at = EXCLUDED.updated_at,
         last_position = EXCLUDED.last_position`,
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
      ],
    );
  },

  async reset(tx: Db): Promise<void> {
    await tx.unsafe(`TRUNCATE renewal_queue`);
  },
};

/** Queue listing for the clinician screen; oldest first. */
export async function listRenewalQueue(
  sql: Db,
  opts: { status?: QueueStatus } = {},
): Promise<RenewalQueueRow[]> {
  const rows = opts.status
    ? await sql.unsafe<Row[]>(
        `SELECT * FROM renewal_queue WHERE status = $1 ORDER BY requested_at ASC, last_position ASC`,
        [opts.status],
      )
    : await sql.unsafe<Row[]>(
        `SELECT * FROM renewal_queue ORDER BY requested_at ASC, last_position ASC`,
      );
  return rows.map(toQueueRow);
}
