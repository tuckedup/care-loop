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

/** Messages that fail validation are dropped (and counted); they never become events. */
export function parsePharmacyBody(body: unknown): { messages: PharmacyMessage[]; invalid: number } {
  const list = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return { messages: [], invalid: 1 };
  const messages: PharmacyMessage[] = [];
  let invalid = 0;
  for (const m of list) {
    const p = PharmacyMessageSchema.safeParse(m);
    if (p.success) messages.push(p.data);
    else invalid += 1;
  }
  return { messages, invalid };
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
  const { messages, invalid } = parsePharmacyBody(input.body);
  const queued = history.some((e) => e.type === "RxRenewalQueued");
  const cancelled = history.some((e) => e.type === "RxCancelAcknowledged");
  const seen = seenIds(history);
  const accepted = input.httpStatus >= 200 && input.httpStatus < 300;

  // Accepted by the pharmacy: the transmission happened (once per idempotency key).
  const alreadyTransmitted = history.some(
    (e) => e.type === "RxRenewalTransmitted" && e.data.idempotencyKey === input.idempotencyKey,
  );
  if (accepted && queued && !alreadyTransmitted) {
    out.push({
      type: "RxRenewalTransmitted",
      data: { v: 1, renewalId, messageId: input.messageId, idempotencyKey: input.idempotencyKey },
    });
  }

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
        if (queued && !cancelled) {
          out.push({ type: "RxFillReceived", data: { v: 1, renewalId, messageId: m.messageId } });
        }
        break;
      case "CancelRx":
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
    const { events, outcome } = decidePharmacyResponse(history, input);
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
