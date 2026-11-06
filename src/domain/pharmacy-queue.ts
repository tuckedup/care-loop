// Approved renewal -> pharmacy transmission (F048). Pure helpers plus the one same-transaction
// command path that appends events AND the outbox row together.
import type { Sql } from "postgres";
import { appendToStream, type AppendResult, type AuditContext } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";
import type { OutboxMessageInput } from "@/infra/outbox/messages";
import { replay, type Aggregate } from "./aggregate";
import { loadStream } from "./aggregate-handler";
import { makeEvent, type DomainEvent } from "./events";

export { rxIdempotencyKey, rxMessageId } from "./pharmacy-keys";

/** Outbox messages implied by the events a command just decided (today: RxRenewalQueued). */
export function outboxFor(events: readonly DomainEvent[]): OutboxMessageInput[] {
  const out: OutboxMessageInput[] = [];
  for (const e of events) {
    if (e.type !== "RxRenewalQueued") continue;
    const { pharmacyId, messageId } = e.data;
    // A queued event without a pharmacy/message id queues nothing: it can never be transmitted.
    if (!pharmacyId || !messageId) continue;
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
): Promise<HandleWithOutboxResult> {
  return withConcurrencyRetry(async () => {
    const { events: history, version } = await loadStream(sql, streamId);
    const decided = aggregate.decide(replay(aggregate, history), command);
    if (decided.length === 0) return { appended: null, version };
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
  if (renewal.some((e) => e.type === "RxCancelAcknowledged")) return no("prescription cancelled");
  return { ok: true };
}
