import { EVENT_TYPES, parseEvent, type DomainEvent } from "@/domain/events";
import { renewalStreamId } from "@/domain/renewal/renewal";
import type { Db, StoredEvent } from "@/infra/event-store/types";
import { recordAnomaly } from "./anomalies";
import type { Projection } from "./runner";

// Assumptions for the future decision aggregate (F042), documented rather than enforced here:
//  - Only the FIRST ClinicianReviewStarted resolves a row (there is no reassignment event yet);
//    a second review start by someone else is ignored and that clinician's decision is refused
//    with CLINICIAN_ID_MISMATCH.
//  - A decision made before ClinicianReviewStarted is not replayed once a review starts: the
//    aggregate must require review-start before accepting an approval/denial of an escalated
//    renewal.
//  - Ids come from application-appended events; rejecting a forged clinicianId at command time is
//    the aggregate's job.

/** FHIR Task.status vocabulary, restricted to the three states the clinician queue shows. */
export type QueueStatus = "requested" | "in-progress" | "completed";
export type QueueDecision = "approved" | "denied" | "follow_up_required";

export interface RenewalQueueRow {
  renewalId: string;
  /** null only on a placeholder created for a schema-invalid RenewalRequested. */
  patientId: string | null;
  prescriptionId: string | null;
  status: QueueStatus;
  outcome: string | null;
  escalated: boolean;
  reasonCodes: string[];
  riskSignalCount: number;
  /** Clinician from the FIRST ClinicianReviewStarted of this renewal (never overwritten). */
  clinicianId: string | null;
  decision: QueueDecision | null;
  decidedBy: string | null;
  /** The clinician a completed approval/denial is attributed to; null for system decisions. */
  decisionClinicianId: string | null;
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
  CLINICIAN_DECISION_WITHOUT_REVIEW_START: "CLINICIAN_DECISION_WITHOUT_REVIEW_START",
  CLINICIAN_ID_MISMATCH: "CLINICIAN_ID_MISMATCH",
  FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN: "FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN",
  ESCALATED_AFTER_NON_CLINICIAN_DECISION: "ESCALATED_AFTER_NON_CLINICIAN_DECISION",
  INVALID_EVENT_FOR_RENEWAL: "INVALID_EVENT_FOR_RENEWAL",
  INVALID_REQUEST_EVENT: "INVALID_REQUEST_EVENT",
} as const;

/** Reason code the rules use (R13) for any LLM risk signal. */
export const LLM_RISK_SIGNAL = "LLM_RISK_SIGNAL";
/** Reason code the rules use (R13) for an LLM failure / invalid output. */
export const LLM_FAILURE = "LLM_FAILURE";
/** Added when an escalation carries no reason code, so reasonCodes is never empty when escalated. */
export const ESCALATED_NO_REASON_CODES = "ESCALATED_NO_REASON_CODES";

/** An outcome of ESCALATE counts as escalated even if RenewalEscalated has not arrived (yet). */
export const isEscalated = (r: Pick<RenewalQueueRow, "escalated" | "outcome">) =>
  r.escalated || r.outcome === "ESCALATE";

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

/**
 * THE central invariant. An escalated renewal may only be 'completed' by a decision attributable
 * to an identified clinician: decidedBy === "clinician", a non-null decision clinician id, and
 * (for escalated rows) a ClinicianReviewStarted of the same renewal whose clinician is that id.
 * Every completion path and every re-open check goes through this predicate or `gate*` below.
 *
 * Remaining assumption (documented, not enforced here): ids come from events appended by the
 * application. An aggregate-level guard that rejects a forged clinicianId at command time is a
 * later feature; this projection only refuses to SHOW such a renewal as completed when the
 * review-start / decision ids disagree or are missing.
 */
export function attributableToClinician(r: RenewalQueueRow): boolean {
  if (r.decidedBy !== "clinician" || !r.decisionClinicianId) return false;
  if (r.clinicianId && r.clinicianId !== r.decisionClinicianId) return false;
  return !isEscalated(r) || r.clinicianId !== null;
}

type Gate =
  | { ok: true; decidedBy: "system" | "clinician"; decisionClinicianId: string | null }
  | { ok: false; code: string };
const refuse = (code: string): Gate => ({ ok: false, code });

function gateApproval(
  current: RenewalQueueRow,
  data: { by: "system" | "clinician"; clinicianId?: string | undefined },
): Gate {
  const escalated = isEscalated(current);
  if (data.by === "system") {
    return escalated
      ? refuse(QUEUE_ANOMALY.SYSTEM_APPROVAL_ON_ESCALATED)
      : { ok: true, decidedBy: "system", decisionClinicianId: null };
  }
  // A clinician approval with no named clinician never completes ANY row.
  // No inference: a clinician approval must name the clinician itself (a review start is not
  // evidence of who approved).
  const id = data.clinicianId;
  if (!id) return refuse(QUEUE_ANOMALY.APPROVAL_WITHOUT_CLINICIAN_ID);
  if (current.clinicianId && id !== current.clinicianId) {
    return refuse(QUEUE_ANOMALY.CLINICIAN_ID_MISMATCH);
  }
  if (escalated && !current.clinicianId) {
    return refuse(QUEUE_ANOMALY.CLINICIAN_DECISION_WITHOUT_REVIEW_START);
  }
  return { ok: true, decidedBy: "clinician", decisionClinicianId: id };
}

function gateDenial(current: RenewalQueueRow): Gate {
  // RenewalDenied carries no actor, so the clinician can only come from ClinicianReviewStarted.
  if (current.clinicianId) {
    return { ok: true, decidedBy: "clinician", decisionClinicianId: current.clinicianId };
  }
  return isEscalated(current)
    ? refuse(QUEUE_ANOMALY.DENIAL_WITHOUT_CLINICIAN_ON_ESCALATED)
    : { ok: true, decidedBy: "system", decisionClinicianId: null };
}

/**
 * Pure reducer. Status rules:
 *  - requested: created, awaiting a decision (including escalated renewals waiting for a clinician)
 *  - in-progress: a clinician started review (first review start only)
 *  - completed: a gated decision was made, or a NON-escalated renewal was sent to follow-up
 * FollowUpRequired on an escalated renewal (before or after the escalation) never completes it:
 * the row stays/reopens as 'requested' with FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN until a
 * clinician acts.
 * Terminal status blocks only status changes. Late escalation signals still set escalated, union
 * reason codes, and re-open a renewal whose completion is not attributable to a clinician.
 * Events for a renewal with no row are ignored (null stays null).
 */
export function reduceRenewalQueue(
  current: RenewalQueueRow | null,
  event: DomainEvent,
  meta: { position: bigint; at: string },
): RenewalQueueRow | null {
  if (event.type === "RenewalRequested") {
    if (current !== null) {
      // First valid request wins; it only fills in a placeholder created for an invalid one
      // (the placeholder keeps its escalated flag and anomaly).
      return current.patientId === null
        ? {
            ...current,
            patientId: event.data.patientId,
            prescriptionId: event.data.prescriptionId,
            updatedAt: meta.at,
            lastPosition: meta.position,
          }
        : current;
    }
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
      decisionClinicianId: null,
      anomalies: [],
      requestedAt: meta.at,
      updatedAt: meta.at,
      lastPosition: meta.position,
      requestPosition: meta.position,
    };
  }
  if (current === null) return current;
  const done = current.status === "completed";
  const next = (over: Partial<RenewalQueueRow>): RenewalQueueRow => ({
    ...current,
    ...over,
    updatedAt: meta.at,
    lastPosition: meta.position,
  });
  const flag = (code: string) => union(current.anomalies, [code]);
  const hold = (code: string) => next({ anomalies: flag(code) });

  /** Mark escalated; re-open a completed renewal that is not attributable to a clinician. */
  const escalate = (codes: readonly string[]): RenewalQueueRow =>
    escalateRow(next({}), codes, current);

  switch (event.type) {
    case "IdentityVerified":
    case "CheckInSubmitted":
      return done ? current : next({});
    case "RiskSignalsExtracted": {
      // R13: any LLM risk signal escalates, through the same path as every other escalation.
      const count = event.data.signals.length;
      return count > 0
        ? { ...escalate([LLM_RISK_SIGNAL]), riskSignalCount: count }
        : next({ riskSignalCount: count });
    }
    case "EligibilityEvaluated": {
      const failed = event.data.results.filter((r) => !r.passed).map((r) => r.ruleId);
      if (event.data.outcome === "ESCALATE") {
        return { ...escalate(failed), outcome: event.data.outcome };
      }
      return next({
        outcome: event.data.outcome,
        ...(event.data.outcome === "REJECT"
          ? { reasonCodes: union(current.reasonCodes, failed) }
          : {}),
      });
    }
    case "RenewalEscalated":
      return escalate(event.data.reasonCodes);
    case "ClinicianReviewStarted":
      // A second review start never overwrites the clinician who already took the task.
      return current.status === "requested"
        ? next({ status: "in-progress", clinicianId: event.data.clinicianId })
        : current;
    case "RenewalApproved": {
      if (done) return current;
      const g = gateApproval(current, event.data);
      return g.ok
        ? next({
            status: "completed",
            decision: "approved",
            decidedBy: g.decidedBy,
            decisionClinicianId: g.decisionClinicianId,
          })
        : hold(g.code);
    }
    case "RenewalDenied": {
      if (done) return current;
      const g = gateDenial(current);
      return g.ok
        ? next({
            status: "completed",
            decision: "denied",
            decidedBy: g.decidedBy,
            decisionClinicianId: g.decisionClinicianId,
          })
        : hold(g.code);
    }
    case "FollowUpRequired":
      if (done) return current;
      return isEscalated(current)
        ? hold(QUEUE_ANOMALY.FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN)
        : next({
            status: "completed",
            decision: "follow_up_required",
            decidedBy: "system",
            decisionClinicianId: null,
          });
    default:
      return current;
  }
}

/** Re-open `row` (derived from `before`) if `before` was completed without clinician attribution. */
function holdIfUnattributed(row: RenewalQueueRow, before: RenewalQueueRow): RenewalQueueRow {
  if (before.status !== "completed" || before.decision === null) return row;
  if (attributableToClinician(row)) return row;
  return {
    ...row,
    status: "requested",
    decision: null,
    decidedBy: null,
    decisionClinicianId: null,
    anomalies: union(row.anomalies, [
      before.decision === "follow_up_required"
        ? QUEUE_ANOMALY.FOLLOW_UP_ON_ESCALATED_WITHOUT_CLINICIAN
        : QUEUE_ANOMALY.ESCALATED_AFTER_NON_CLINICIAN_DECISION,
    ]),
  };
}

/** Reason codes merged: de-duplicated union; never empty once escalated. */
function mergeCodes(a: readonly string[], b: readonly string[]): string[] {
  const u = union(a, b);
  const specific = u.filter((c) => c !== ESCALATED_NO_REASON_CODES);
  if (specific.length > 0) return specific;
  return [ESCALATED_NO_REASON_CODES];
}

/** Mark escalated with merged reason codes; re-open a completion `before` that has no clinician. */
function escalateRow(
  row: RenewalQueueRow,
  codes: readonly string[],
  before: RenewalQueueRow,
): RenewalQueueRow {
  return holdIfUnattributed(
    { ...row, escalated: true, reasonCodes: mergeCodes(row.reasonCodes, codes) },
    before,
  );
}

/** Invalid event types whose lost content may have been an escalation (R13 included). */
const ESCALATION_CODES: Record<string, readonly string[]> = {
  RenewalEscalated: [],
  EligibilityEvaluated: [],
  RiskSignalsExtracted: [LLM_FAILURE],
};

/**
 * A schema-invalid event for an existing renewal. Fail closed: flag the row, hold it open (a
 * completion that is not clinician-attributable is re-opened), and for escalation-type events
 * set escalated = true because the lost content may have been the escalation itself.
 */
export function reduceInvalidEvent(
  current: RenewalQueueRow | null,
  eventType: string,
  meta: { position: bigint; at: string },
): RenewalQueueRow | null {
  if (current === null) return null;
  const flagged: RenewalQueueRow = {
    ...current,
    anomalies: union(current.anomalies, [QUEUE_ANOMALY.INVALID_EVENT_FOR_RENEWAL]),
    updatedAt: meta.at,
    lastPosition: meta.position,
  };
  return Object.hasOwn(ESCALATION_CODES, eventType)
    ? escalateRow(flagged, ESCALATION_CODES[eventType]!, current)
    : holdIfUnattributed(flagged, current);
}

/**
 * A schema-invalid RenewalRequested: the renewal must not vanish. Creates a placeholder row keyed
 * by the stream-derived renewal id (patient/prescription unknown, escalated, anomaly set) so it is
 * visible and open, and later valid events apply to it. If a row already exists it is flagged.
 */
export function reduceInvalidRequest(
  renewalId: string,
  current: RenewalQueueRow | null,
  meta: { position: bigint; at: string },
): RenewalQueueRow {
  if (current !== null) return reduceInvalidEvent(current, "RenewalRequested", meta)!;
  return {
    renewalId,
    patientId: null,
    prescriptionId: null,
    status: "requested",
    outcome: null,
    escalated: true,
    reasonCodes: [QUEUE_ANOMALY.INVALID_REQUEST_EVENT],
    riskSignalCount: 0,
    clinicianId: null,
    decision: null,
    decidedBy: null,
    decisionClinicianId: null,
    anomalies: [QUEUE_ANOMALY.INVALID_REQUEST_EVENT],
    requestedAt: meta.at,
    updatedAt: meta.at,
    lastPosition: meta.position,
    requestPosition: meta.position,
  };
}

interface Row {
  renewal_id: string;
  patient_id: string | null;
  prescription_id: string | null;
  status: QueueStatus;
  outcome: string | null;
  escalated: boolean;
  reason_codes: string[];
  risk_signal_count: number;
  clinician_id: string | null;
  decision: QueueDecision | null;
  decided_by: string | null;
  decision_clinician_id: string | null;
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
    decisionClinicianId: r.decision_clinician_id,
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
const STREAM_PREFIX = renewalStreamId("");

async function loadRow(tx: Db, renewalId: string): Promise<RenewalQueueRow | null> {
  const [existing] = await tx.unsafe<Row[]>(
    `SELECT * FROM renewal_queue WHERE renewal_id = $1 FOR UPDATE`,
    [renewalId],
  );
  return existing ? toQueueRow(existing) : null;
}

async function writeRow(tx: Db, next: RenewalQueueRow): Promise<void> {
  await tx.unsafe(
    `INSERT INTO renewal_queue (renewal_id, patient_id, prescription_id, status, outcome,
        escalated, reason_codes, risk_signal_count, clinician_id, decision, decided_by,
        decision_clinician_id, requested_at, updated_at, last_position, request_position, anomalies)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11, $12,
             $13::timestamptz, $14::timestamptz, $15::bigint, $16::bigint, $17::text::jsonb)
     ON CONFLICT (renewal_id) DO UPDATE SET
       status = EXCLUDED.status, outcome = EXCLUDED.outcome, escalated = EXCLUDED.escalated,
       reason_codes = EXCLUDED.reason_codes, risk_signal_count = EXCLUDED.risk_signal_count,
       clinician_id = EXCLUDED.clinician_id, decision = EXCLUDED.decision,
       decided_by = EXCLUDED.decided_by, decision_clinician_id = EXCLUDED.decision_clinician_id,
       updated_at = EXCLUDED.updated_at, last_position = EXCLUDED.last_position,
       anomalies = EXCLUDED.anomalies`,
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
      next.decisionClinicianId,
      next.requestedAt,
      next.updatedAt,
      next.lastPosition.toString(),
      next.requestPosition.toString(),
      JSON.stringify(next.anomalies),
    ],
  );
}

export const renewalQueueProjection: Projection = {
  name: "renewal_queue",

  async handle(tx: Db, stored: StoredEvent): Promise<void> {
    if (!KNOWN.has(stored.type) || !QUEUE_TYPES.has(stored.type)) return;
    let event: DomainEvent;
    try {
      event = parseEvent({ type: stored.type, data: stored.data });
    } catch (e) {
      // Skip and record; the runner checkpoint advances so one bad event cannot halt the queue.
      // Fail closed for the renewal it belongs to (identified by its stream), if we have a row.
      await recordAnomaly(tx, "renewal_queue", stored, "INVALID_EVENT", String(e));
      const id = stored.streamId.startsWith(STREAM_PREFIX)
        ? stored.streamId.slice(STREAM_PREFIX.length)
        : "";
      if (id !== "") {
        const m = { position: stored.globalPosition, at: stored.createdAt.toISOString() };
        const row = await loadRow(tx, id);
        const marked =
          stored.type === "RenewalRequested"
            ? reduceInvalidRequest(id, row, m)
            : reduceInvalidEvent(row, stored.type, m);
        if (marked) await writeRow(tx, marked);
      }
      return;
    }
    const renewalId = (event.data as { renewalId?: string }).renewalId;
    if (typeof renewalId !== "string") return;
    if (stored.streamId !== renewalStreamId(renewalId)) {
      // Never let an event in one renewal's stream mutate another renewal's row.
      await recordAnomaly(
        tx,
        "renewal_queue",
        stored,
        "STREAM_RENEWAL_MISMATCH",
        `stream ${stored.streamId} carries renewalId ${renewalId}`,
      );
      return;
    }
    const current = await loadRow(tx, renewalId);
    const next = reduceRenewalQueue(current, event, {
      position: stored.globalPosition,
      at: stored.createdAt.toISOString(),
    });
    if (next === null || next === current) return;
    await writeRow(tx, next);
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
        `SELECT * FROM renewal_queue WHERE status = $1
         ORDER BY escalated DESC, requested_at ASC, request_position ASC`,
        [opts.status],
      )
    : await sql.unsafe<Row[]>(
        `SELECT * FROM renewal_queue ORDER BY escalated DESC, requested_at ASC, request_position ASC`,
      );
  return rows.map(toQueueRow);
}
