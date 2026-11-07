// Approved renewal -> pharmacy transmission (F048). Pure helpers plus the one same-transaction
// command path that appends events AND the outbox row together.
import type { Sql } from "postgres";
import { appendToStream, type AppendResult, type AuditContext } from "@/infra/audit";
import { readStream, withConcurrencyRetry } from "@/infra/event-store";
import { foldRxStatus } from "@/infra/projections/rx-status";
import type { OutboxMessageInput } from "@/infra/outbox/messages";
import { replay, type Aggregate } from "./aggregate";
import { loadStream } from "./aggregate-handler";
import { isAiPathPermitted } from "@/ai/ai-path-gate";
import { makeEvent, type DomainEvent, type EventData } from "./events";
import { buildRuleInput } from "./renewal/decision";
import { renewalStreamId } from "./renewal/renewal";
import { isStalled, SUPERSEDABLE_CODES } from "./pharmacy-stall";

export { rxIdempotencyKey, rxMessageId } from "./pharmacy-keys";

/** Outbox messages implied by the events a command just decided (today: RxRenewalQueued). */
export function outboxFor(events: readonly DomainEvent[]): OutboxMessageInput[] {
  const out: OutboxMessageInput[] = [];
  for (const e of events) {
    if (e.type !== "RxRenewalQueued") continue;
    const { pharmacyId, messageId } = e.data;
    // A queued event without a pharmacy/message id queues nothing: it can never be transmitted.
    if (!pharmacyId || !messageId) continue;
    // Supersede: cancel each stalled earlier renewal in the SAME transaction as this send.
    for (const s of e.data.supersedes ?? []) {
      out.push({
        type: "pharmacy.CancelRx",
        idempotencyKey: rxCancelKey(s.renewalId, e.data.renewalId),
        payload: {
          renewalId: s.renewalId,
          prescriptionId: e.data.prescriptionId,
          pharmacyId: s.pharmacyId,
          messageId: `rxcancel-${s.renewalId}-${e.data.renewalId}`,
        },
      });
    }
    out.push({
      type: "pharmacy.RxRenewalResponse",
      idempotencyKey: e.data.idempotencyKey,
      payload: {
        renewalId: e.data.renewalId,
        prescriptionId: e.data.prescriptionId,
        pharmacyId,
        messageId,
        response: "Approved",
      },
    });
  }
  return out;
}

/**
 * POSITIVE allow-list at the transmit gate, independent of the schedule flag on the order: the
 * medication must resolve (RxCUI + name + dose checks, the rules' own R02/M01/M02) to an
 * allowlisted, non-controlled formulary entry, and no controlled signal may appear anywhere
 * (schedule flag, RxCUI, formulary id, or a controlled drug named in the text, incl. homoglyphs).
 * A null schedule alone is never enough: "alprazolam" with schedule null is refused.
 */
export function medicationTransmittable(order: EventData<"MedicationPrescribed">): boolean {
  try {
    const input = buildRuleInput({
      renewalId: "transmit-gate",
      identityVerified: true,
      order,
      checkIn: {
        v: 1,
        renewalId: "transmit-gate",
        phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        gad7: [0, 0, 0, 0, 0, 0, 0],
        sideEffects: [],
        severeSideEffect: false,
        pregnancy: "no",
        maniaScreen: false,
        freeText: "",
        requestedHuman: false,
        requestedChange: "none",
      },
      renewalsSinceLastVisit: 0,
      refillLimit: 2,
      priorPhq9Total: null,
      now: new Date(0),
    });
    return isAiPathPermitted(input);
  } catch {
    return false;
  }
}

/** Idempotency key of the CancelRx that supersedes `superseded` when `by` is approved. */
export const rxCancelKey = (superseded: string, by: string) => `rx-cancel:${superseded}:${by}`;

/**
 * Earlier renewals of the same prescription that are unsettled but past the point of waiting
 * (STALLED by the injected clock, or marked stalled/unconfirmed) and not yet superseded. Fail-soft:
 * on any read problem nothing is superseded (R2 then simply fails the duplicate-send guard).
 */
export async function findSupersedable(
  sql: Sql,
  renewalId: string,
  opts: { now: Date; staleHours: number },
): Promise<{ renewalId: string; pharmacyId: string }[]> {
  try {
    const mine = (await loadStream(sql, renewalStreamId(renewalId))).events.find(
      (e) => e.type === "RenewalRequested",
    );
    if (!mine || mine.type !== "RenewalRequested") return [];
    const others = await sql.unsafe<{ stream_id: string }[]>(
      `SELECT DISTINCT stream_id FROM events
       WHERE type = 'RenewalRequested' AND data->>'prescriptionId' = $1 AND stream_id <> $2`,
      [mine.data.prescriptionId, renewalStreamId(renewalId)],
    );
    const out: { renewalId: string; pharmacyId: string }[] = [];
    for (const o of others) {
      const stored = await readStream(sql, o.stream_id);
      const row = foldRxStatus(stored);
      if (!row) continue;
      const queued = stored.find((e) => e.type === "RxRenewalQueued");
      const pharmacyId = (queued?.data as { pharmacyId?: string } | undefined)?.pharmacyId;
      if (!queued || !pharmacyId) continue;
      const unconfirmed =
        row.status === "pharmacy_error" &&
        SUPERSEDABLE_CODES.some((c) => row.pharmacyStatus === `ERROR:${c}`);
      if (!unconfirmed && !isStalled(row, opts.now, opts.staleHours)) continue;
      const already = await sql.unsafe(
        `SELECT 1 FROM events WHERE type = 'RxRenewalQueued'
         AND data->'supersedes' @> $1::text::jsonb LIMIT 1`,
        [JSON.stringify([{ renewalId: row.renewalId }])],
      );
      if (already.length > 0) continue;
      out.push({ renewalId: row.renewalId, pharmacyId });
    }
    return out;
  } catch {
    return [];
  }
}

export interface HandleWithOutboxResult {
  appended: AppendResult | null;
  version: number;
}

/**
 * Like handleCommand, but the outbox rows implied by the decided events are written in the SAME
 * transaction as the events and the audit entry (appendToStream does the atomic insert).
 */
export function handleCommandWithOutbox<State, Command>(
  sql: Sql,
  aggregate: Aggregate<State, Command>,
  streamId: string,
  command: Command,
  ctx: AuditContext,
  /** Runs after decide, before anything is written; throw to refuse. */
  guard?: (decided: DomainEvent[]) => Promise<void>,
): Promise<HandleWithOutboxResult> {
  return withConcurrencyRetry(async () => {
    const { events: history, version } = await loadStream(sql, streamId);
    const decided = aggregate.decide(replay(aggregate, history), command);
    if (decided.length === 0) return { appended: null, version };
    if (guard) await guard(decided);
    const appended = await appendToStream(
      sql,
      streamId,
      version,
      decided.map((e) => makeEvent(e.type, e.data as never)),
      ctx,
      undefined,
      outboxFor(decided),
    );
    return { appended, version: version + decided.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Defence in depth: the transmit handler re-checks everything from the event streams, so even a
// forged outbox row cannot send an unapproved, rejected or controlled renewal.

export interface TransmitFacts {
  renewalId: string;
  prescriptionId: string;
  pharmacyId: string;
  messageId: string;
  idempotencyKey: string;
}

export interface ReviewFacts {
  decision: string | null;
  decidedBy: string | null;
  controlled: boolean;
  blocked: boolean;
  outcome: string | null;
  escalated: boolean;
  reviewerId: string | null;
}

export type TransmitCheck = { ok: true } | { ok: false; reason: string };

/**
 * `renewal` is the renewal stream, `patient` the prescription (rx-*) stream, `review` the folded review
 * state. Every failure is a refusal (fail closed); the caller must dead-letter, never retry.
 */
export function checkTransmittable(
  renewal: readonly DomainEvent[],
  patient: readonly DomainEvent[],
  facts: TransmitFacts,
  review: ReviewFacts,
): TransmitCheck {
  const no = (reason: string): TransmitCheck => ({ ok: false, reason });
  const requested = renewal.find((e) => e.type === "RenewalRequested");
  if (!requested || requested.type !== "RenewalRequested") return no("renewal was never requested");
  if (requested.data.prescriptionId !== facts.prescriptionId) return no("prescription mismatch");

  if (review.decision !== "approved" || review.decidedBy !== "clinician") {
    return no("no clinician approval");
  }
  const approvals = renewal.filter(
    (e) => e.type === "RenewalApproved" && e.data.by === "clinician" && !!e.data.clinicianId,
  );
  if (approvals.length === 0) return no("no clinician approval event");
  if (renewal.some((e) => e.type === "RenewalDenied")) return no("renewal was denied");
  if (review.controlled) return no("controlled substance");
  if (review.blocked || review.outcome === "REJECT" || review.outcome === "FOLLOW_UP_REQUIRED") {
    return no("renewal was rejected by the rules");
  }
  if (review.escalated && review.reviewerId === null) return no("escalated without a review");

  const queued = renewal.find((e) => e.type === "RxRenewalQueued");
  if (
    !queued ||
    queued.type !== "RxRenewalQueued" ||
    queued.data.idempotencyKey !== facts.idempotencyKey ||
    queued.data.messageId !== facts.messageId ||
    queued.data.pharmacyId !== facts.pharmacyId
  ) {
    return no("no matching RxRenewalQueued");
  }
  const selected = renewal.filter((e) => e.type === "PharmacySelected");
  const last = selected[selected.length - 1];
  if (!last || last.type !== "PharmacySelected" || last.data.pharmacyId !== facts.pharmacyId) {
    return no("pharmacy not confirmed by the patient");
  }

  const med = patient.find(
    (e) =>
      e.type === "MedicationPrescribed" &&
      e.data.prescriptionId === facts.prescriptionId &&
      e.data.patientId === requested.data.patientId,
  );
  if (!med || med.type !== "MedicationPrescribed") return no("medication not found");
  if (med.data.controlledSchedule !== null) return no("controlled substance");
  if (!medicationTransmittable(med.data)) {
    return no("controlled substance or medication not on the allow-list");
  }
  if (renewal.some((e) => e.type === "RxCancelAcknowledged")) return no("prescription cancelled");
  return { ok: true };
}
