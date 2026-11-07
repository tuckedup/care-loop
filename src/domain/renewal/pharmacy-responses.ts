// Consuming the pharmacy's answers (F049). A response body is a list of SCRIPT-style messages
// (Status, Error, RxFill, CancelRx acknowledgement, PharmacistEscalation). Each becomes an event on
// the renewal stream, deduplicated on its messageId: a replayed or duplicated message never adds a
// second event. Pure decide + one audited append.
import type { Sql } from "postgres";
import { z } from "zod";
import { appendToStream, type AuditContext } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";
import { loadStream } from "../aggregate-handler";
import { makeEvent, type DomainEvent } from "../events";
import { CANCEL_AFTER_FILL_CODE, FILL_AFTER_SUPERSEDE_CODE } from "../pharmacy-stall";
import { renewalStreamId } from "./renewal";

const id = z.string().min(1).max(200);

export const PharmacyMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Status"), messageId: id, status: z.string().min(1).max(100) }),
  z.object({
    type: z.literal("Error"),
    messageId: id,
    code: z.string().min(1).max(100),
    retryable: z.boolean(),
    description: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("RxFill"),
    messageId: id,
    renewalId: id.optional(),
    prescriptionId: id.optional(),
  }),
  z.object({ type: z.literal("CancelRx"), messageId: id, acknowledged: z.literal(true) }),
  z.object({
    type: z.literal("PharmacistEscalation"),
    messageId: id,
    message: z.string().min(1).max(2000),
  }),
]);
export type PharmacyMessage = z.infer<typeof PharmacyMessageSchema>;

/** A pharmacy answer larger than this, or with more messages, is a fatal parse error (fail closed). */
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_RESPONSE_MESSAGES = 50;
/** Marker body the transport substitutes when the answer exceeded MAX_RESPONSE_BYTES. */
export const OVERSIZE_BODY = { __oversize: true } as const;

/** Messages that fail validation are dropped (and counted); they never become events. */
export function parsePharmacyBody(body: unknown): {
  messages: PharmacyMessage[];
  invalid: number;
  tooLarge: boolean;
} {
  if ((body as { __oversize?: unknown } | null)?.__oversize === true) {
    return { messages: [], invalid: 0, tooLarge: true };
  }
  const list = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return { messages: [], invalid: 1, tooLarge: false };
  if (list.length > MAX_RESPONSE_MESSAGES) return { messages: [], invalid: 0, tooLarge: true };
  const messages: PharmacyMessage[] = [];
  let invalid = 0;
  for (const m of list) {
    const p = PharmacyMessageSchema.safeParse(m);
    if (p.success) messages.push(p.data);
    else invalid += 1;
  }
  return { messages, invalid, tooLarge: false };
}

export type ConsumeOutcome =
  | { kind: "ok"; events: number }
  /** The worker should retry with backoff (a retryable pharmacy error, 5xx, empty/garbled body). */
  | { kind: "retry"; reason: string; events: number }
  /** A non-retryable pharmacy error: recorded, surfaced to people, never retried. */
  | { kind: "fatal"; reason: string; events: number };

export interface ResponseInput {
  renewalId: string;
  /** messageId of OUR request and the outbox idempotency key it was sent under. */
  messageId: string;
  idempotencyKey: string;
  httpStatus: number;
  body: unknown;
  /** "cancel" = the answer to a CancelRx (never counts as a transmission of the renewal). */
  kind?: "send" | "cancel";
  /** Renewals whose approval superseded this one (read from the store by the consumer). */
  supersededBy?: readonly string[];
}

const seenIds = (events: readonly DomainEvent[]): Set<string> => {
  const s = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "PharmacyStatusReceived":
      case "PharmacyErrorReceived":
      case "RxFillReceived":
      case "RxCancelAcknowledged":
      case "PharmacistEscalationReceived":
        s.add(e.data.messageId);
        break;
      default:
    }
  }
  return s;
};

/** Pure: which events does this response add to the stream, and what should the worker do? */
export function decidePharmacyResponse(
  history: readonly DomainEvent[],
  input: ResponseInput,
): { events: DomainEvent[]; outcome: ConsumeOutcome } {
  const { renewalId } = input;
  const out: DomainEvent[] = [];
  const { messages, invalid, tooLarge } = parsePharmacyBody(input.body);
  if (tooLarge) {
    // Never turn a flood into events: nothing is recorded, the message is dead-lettered and alerted.
    return {
      events: [],
      outcome: { kind: "fatal", reason: "pharmacy response too large", events: 0 },
    };
  }
  const queuedEvent = history.find((e) => e.type === "RxRenewalQueued");
  const queued = queuedEvent !== undefined;
  const queuedRx = queuedEvent?.type === "RxRenewalQueued" ? queuedEvent.data.prescriptionId : null;
  let cancelled = history.some((e) => e.type === "RxCancelAcknowledged");
  let filled = history.some((e) => e.type === "RxFillReceived");
  const seen = seenIds(history);
  const accepted = input.httpStatus >= 200 && input.httpStatus < 300;

  const alreadyTransmitted = history.some(
    (e) => e.type === "RxRenewalTransmitted" && e.data.idempotencyKey === input.idempotencyKey,
  );
  let retryable: string | null = null;
  let fatal: string | null = null;
  for (const m of messages) {
    if (m.type === "Error") {
      if (m.retryable) retryable ??= `${m.code} (retryable)`;
      else fatal ??= m.code;
    }
    if (seen.has(m.messageId)) continue; // dedupe on messageId (also within this batch)
    seen.add(m.messageId);
    switch (m.type) {
      case "Status":
        out.push({
          type: "PharmacyStatusReceived",
          data: { v: 1, renewalId, messageId: m.messageId, status: m.status },
        });
        break;
      case "Error":
        out.push({
          type: "PharmacyErrorReceived",
          data: {
            v: 1,
            renewalId,
            messageId: m.messageId,
            code: m.code,
            retryable: m.retryable,
          },
        });
        break;
      case "RxFill":
        // A fill only means something for a renewal we queued, and never after a cancel.
        // ...and only if it names this renewal and prescription (no cross-attribution).
        if (
          queued &&
          (m.renewalId === undefined || m.renewalId === renewalId) &&
          (m.prescriptionId === undefined || m.prescriptionId === queuedRx)
        ) {
          if ((input.supersededBy?.length ?? 0) > 0) {
            // A fill for a SUPERSEDED renewal: record it (it happened) and flag it for a person.
            // It never re-opens the renewal (filled is terminal) and is never silently ignored.
            out.push({ type: "RxFillReceived", data: { v: 1, renewalId, messageId: m.messageId } });
            filled = true;
            out.push({
              type: "PharmacyErrorReceived",
              data: {
                v: 1,
                renewalId,
                messageId: `${m.messageId}:after-supersede`,
                code: FILL_AFTER_SUPERSEDE_CODE,
                retryable: false,
              },
            });
          } else if (!cancelled) {
            out.push({ type: "RxFillReceived", data: { v: 1, renewalId, messageId: m.messageId } });
            filled = true;
          }
        }
        break;
      case "CancelRx":
        if (filled) {
          // Too late: the prescription was filled. Record the anomaly once (alerted), but never
          // append a cancel acknowledgement that would read as a status change.
          out.push({
            type: "PharmacyErrorReceived",
            data: {
              v: 1,
              renewalId,
              messageId: `${m.messageId}:after-fill`,
              code: CANCEL_AFTER_FILL_CODE,
              retryable: false,
            },
          });
          break;
        }
        cancelled = true;
        out.push({
          type: "RxCancelAcknowledged",
          data: { v: 1, renewalId, messageId: m.messageId },
        });
        break;
      case "PharmacistEscalation":
        out.push({
          type: "PharmacistEscalationReceived",
          data: { v: 1, renewalId, messageId: m.messageId, message: m.message },
        });
        break;
    }
  }

  let outcome: ConsumeOutcome;
  if (fatal !== null) {
    outcome = { kind: "fatal", reason: `pharmacy error ${fatal}`, events: out.length };
  } else if (retryable !== null) {
    outcome = { kind: "retry", reason: `pharmacy error ${retryable}`, events: out.length };
  } else if (!accepted) {
    outcome =
      input.httpStatus >= 500 || input.httpStatus === 429 || input.httpStatus === 408
        ? { kind: "retry", reason: `pharmacy HTTP ${input.httpStatus}`, events: out.length }
        : { kind: "fatal", reason: `pharmacy HTTP ${input.httpStatus}`, events: out.length };
  } else if (messages.length === 0) {
    outcome = {
      kind: "retry",
      reason: invalid > 0 ? "unparseable pharmacy response" : "empty pharmacy response",
      events: out.length,
    };
  } else {
    outcome = { kind: "ok", events: out.length };
  }
  // Accepted by the pharmacy (a clean, non-error answer): the transmission happened, once per
  // idempotency key. A garbled or error answer is NOT a transmission, so its retry still sends.
  if (
    outcome.kind === "ok" &&
    accepted &&
    queued &&
    !alreadyTransmitted &&
    input.kind !== "cancel"
  ) {
    out.unshift({
      type: "RxRenewalTransmitted",
      data: { v: 1, renewalId, messageId: input.messageId, idempotencyKey: input.idempotencyKey },
    });
    outcome = { kind: "ok", events: out.length };
  }
  return { events: out, outcome };
}

/** Load -> decide -> one audited append (events + audit entry in a single transaction). */
export async function consumePharmacyResponse(
  sql: Sql,
  input: ResponseInput,
  ctx: AuditContext,
): Promise<ConsumeOutcome> {
  return withConcurrencyRetry(async () => {
    const { events: history, version } = await loadStream(sql, renewalStreamId(input.renewalId));
    const supersededBy = (
      await sql.unsafe<{ rid: string }[]>(
        `SELECT data->>'renewalId' AS rid FROM events
         WHERE type = 'RxRenewalQueued' AND data->'supersedes' @> $1::text::jsonb`,
        [JSON.stringify([{ renewalId: input.renewalId }])],
      )
    ).map((r) => r.rid);
    const { events, outcome } = decidePharmacyResponse(history, { ...input, supersededBy });
    if (events.length > 0) {
      await appendToStream(
        sql,
        renewalStreamId(input.renewalId),
        version,
        events.map((e) => makeEvent(e.type, e.data as never)),
        { ...ctx, detail: { renewalId: input.renewalId, requestMessageId: input.messageId } },
      );
    }
    return outcome;
  });
}
