// Outbox handler: transmit an approved renewal to the (mock) pharmacy (F048).
//
// Safety: this is the only code that sends a prescription out. Before any network call it
// re-derives, from the event streams (not from the outbox payload), that a clinician approved the
// renewal, that the rules did not reject it, that the medication is not controlled, and that the
// patient confirmed this pharmacy. Any doubt => NonRetryableError (dead-letter), never a send.
//
// Idempotency: the outbox idempotencyKey is sent as the Idempotency-Key header; the request body
// carries the messageId; RxRenewalTransmitted is appended at most once per key.
import type { Sql } from "postgres";
import { replay } from "@/domain/aggregate";
import { loadStream } from "@/domain/aggregate-handler";
import { makeEvent, type DomainEvent } from "@/domain/events";
import { appendToStream } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";
import { checkTransmittable, rxCancelKey } from "@/domain/pharmacy-queue";
import { SUPERSEDABLE_CODES, UNCONFIRMED_CODE } from "@/domain/pharmacy-stall";
import { rxStreamId } from "@/domain/patient/patient";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { reviewAggregate } from "@/domain/renewal/review";
import { OUTBOX_PAYLOADS } from "./messages";
import { NonRetryableError, type DeadLetterHook, type OutboxHandler } from "./worker";
import {
  consumePharmacyResponse,
  MAX_RESPONSE_BYTES,
  OVERSIZE_BODY,
  type ConsumeOutcome,
} from "@/domain/renewal/pharmacy-responses";

export interface TransmitDeps {
  sql: Sql;
  /** Origin of the pharmacy endpoint; the mock lives at `${baseUrl}/api/mock-pharmacy`. */
  baseUrl: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const MOCK_PHARMACY_PATH = "/api/mock-pharmacy";

const ctxOf = (action: string) => ({ actor: "outbox-worker", role: "system" as const, action });

/** Network / 5xx / unparseable answer: the worker retries with backoff. */
export class PharmacyRetryableError extends Error {
  override readonly name = "PharmacyRetryableError";
}

export function createTransmitHandler(deps: TransmitDeps): OutboxHandler {
  const doFetch = deps.fetch ?? fetch;
  const url = new URL(MOCK_PHARMACY_PATH, deps.baseUrl).toString();
  return async (message) => {
    const payload = OUTBOX_PAYLOADS["pharmacy.RxRenewalResponse"].parse(message.payload);
    const facts = {
      renewalId: payload.renewalId,
      prescriptionId: payload.prescriptionId,
      pharmacyId: payload.pharmacyId,
      messageId: payload.messageId,
      idempotencyKey: message.idempotencyKey,
    };

    // ---- defence in depth (no network yet) -------------------------------------------------
    const { events: renewal } = await loadStream(deps.sql, renewalStreamId(facts.renewalId));
    const requested = renewal.find((e) => e.type === "RenewalRequested");
    if (!requested || requested.type !== "RenewalRequested") {
      throw new NonRetryableError("REFUSED: renewal was never requested");
    }
    const { events: medication } = await loadStream(deps.sql, rxStreamId(facts.prescriptionId));
    const check = checkTransmittable(renewal, medication, facts, replay(reviewAggregate, renewal));
    if (!check.ok) throw new NonRetryableError(`REFUSED: ${check.reason}`);
    const known = await deps.sql.unsafe(`SELECT 1 FROM pharmacies WHERE id = $1`, [
      facts.pharmacyId,
    ]);
    if (known.length === 0) throw new NonRetryableError("REFUSED: unknown pharmacy");

    // Deterministic duplicate guard: if ANOTHER renewal of this prescription was queued EARLIER and
    // is not settled, this one is refused (dead-lettered with an alert); the earliest queued renewal
    // wins, so two renewals can never both send and never both strand. "Settled" = filled,
    // cancelled, SUPERSEDED by a newer approval (its CancelRx is queued), or a fatal pharmacy error;
    // a STALLED / UNCONFIRMED one (accepted, never filled) still counts as unsettled until a
    // clinician's newer approval supersedes it, so nothing is silently sent twice.
    const earlier = await deps.sql.unsafe(
      `SELECT q.stream_id FROM events q
       WHERE q.type = 'RxRenewalQueued' AND q.data->>'prescriptionId' = $1 AND q.stream_id <> $2
         AND q.global_position < (SELECT min(m.global_position) FROM events m
                                  WHERE m.stream_id = $2 AND m.type = 'RxRenewalQueued')
         AND NOT EXISTS (SELECT 1 FROM events d WHERE d.stream_id = q.stream_id
                         AND (d.type IN ('RxFillReceived', 'RxCancelAcknowledged')
                              OR (d.type = 'PharmacyErrorReceived' AND d.data->>'retryable' = 'false'
                                  AND d.data->>'code' <> ALL($3::text[]))))
         AND NOT EXISTS (SELECT 1 FROM events s WHERE s.type = 'RxRenewalQueued'
                         AND s.data->'supersedes' @> jsonb_build_array(
                               jsonb_build_object('renewalId', q.data->>'renewalId')))`,
      [facts.prescriptionId, renewalStreamId(facts.renewalId), [...SUPERSEDABLE_CODES]],
    );
    if (earlier.length > 0) {
      throw new NonRetryableError(
        "REFUSED: an earlier renewal of this prescription is in flight (duplicate send prevented)",
      );
    }

    // A redelivery after the pharmacy already settled the message must not call out again.
    if (isSettled(renewal, facts.idempotencyKey)) return;

    // ---- send --------------------------------------------------------------------------------
    const signal = AbortSignal.any([message.signal, AbortSignal.timeout(deps.timeoutMs ?? 10_000)]);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
        },
        body: JSON.stringify({
          type: "RxRenewalResponse",
          response: payload.response,
          messageId: payload.messageId,
          renewalId: payload.renewalId,
          prescriptionId: payload.prescriptionId,
          pharmacyId: payload.pharmacyId,
          attempt: message.attempt,
        }),
        signal,
      });
    } catch (e) {
      throw new PharmacyRetryableError(`pharmacy request failed: ${String(e)}`);
    }
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text.length > MAX_RESPONSE_BYTES ? OVERSIZE_BODY : JSON.parse(text);
    } catch {
      body = null;
    }
    const outcome: ConsumeOutcome = await consumePharmacyResponse(
      deps.sql,
      { ...facts, httpStatus: response.status, body },
      ctxOf("pharmacy:consume-response"),
    );
    if (outcome.kind === "retry") throw new PharmacyRetryableError(outcome.reason);
    if (outcome.kind === "fatal") throw new NonRetryableError(outcome.reason);
  };
}

export const DEAD_LETTER_CODE = "TRANSMIT_DEAD_LETTERED";

/**
 * Dead-letter hook for pharmacy.RxRenewalResponse: a queued renewal whose transmission can never
 * happen (a refusal by the guard, a fatal HTTP error, retries exhausted) gets a terminal,
 * non-retryable PharmacyErrorReceived. rx_status then shows a problem (not "approved"), the
 * clinician and pharmacist see an alert, and the patient may renew again. Idempotent: it appends
 * nothing if the renewal is not queued under this key, was already settled (fill, cancel, any
 * fatal pharmacy error already surfaced) or already carries this hook's event.
 */
export function createTransmitDeadLetterHook(sql: Sql): DeadLetterHook {
  return async (m) => {
    const payload = OUTBOX_PAYLOADS["pharmacy.RxRenewalResponse"].safeParse(m.payload);
    if (!payload.success) return;
    const renewalId = payload.data.renewalId;
    const messageId = `deadletter:${m.idempotencyKey}`;
    await withConcurrencyRetry(async () => {
      const { events, version } = await loadStream(sql, renewalStreamId(renewalId));
      const queued = events.some(
        (e) => e.type === "RxRenewalQueued" && e.data.idempotencyKey === m.idempotencyKey,
      );
      if (!queued) return; // forged / never-queued row: nothing of the patient's was promised
      const handled = events.some(
        (e) =>
          e.type === "RxFillReceived" ||
          e.type === "RxCancelAcknowledged" ||
          (e.type === "PharmacyErrorReceived" &&
            (!e.data.retryable || e.data.messageId === messageId)),
      );
      if (handled) return;
      // Sent but never confirmed (e.g. a leased message reaped to dead) is NOT "could not be sent".
      const wasTransmitted = events.some(
        (e) => e.type === "RxRenewalTransmitted" && e.data.idempotencyKey === m.idempotencyKey,
      );
      await appendToStream(
        sql,
        renewalStreamId(renewalId),
        version,
        [
          makeEvent("PharmacyErrorReceived", {
            v: 1,
            renewalId,
            messageId,
            code: wasTransmitted ? UNCONFIRMED_CODE : DEAD_LETTER_CODE,
            retryable: false,
          }),
        ],
        {
          actor: "outbox-worker",
          role: "system",
          action: "pharmacy:dead-letter",
          detail: {
            renewalId,
            idempotencyKey: m.idempotencyKey,
            attempts: m.attempts,
            error: m.lastError,
          },
        },
      );
    });
  };
}

/**
 * CancelRx for a SUPERSEDED renewal (queued in the same transaction as the newer renewal's send).
 * Guard: the newer renewal must carry a RxRenewalQueued that supersedes this one with the same
 * pharmacy and a clinician approval. A renewal that already ended (cancel) needs nothing.
 */
export function createCancelHandler(deps: TransmitDeps): OutboxHandler {
  const doFetch = deps.fetch ?? fetch;
  const url = new URL(MOCK_PHARMACY_PATH, deps.baseUrl).toString();
  return async (message) => {
    const payload = OUTBOX_PAYLOADS["pharmacy.CancelRx"].parse(message.payload);
    const prefix = `rx-cancel:${payload.renewalId}:`;
    if (!message.idempotencyKey.startsWith(prefix)) {
      throw new NonRetryableError("REFUSED: cancel key does not name the renewal");
    }
    const newerId = message.idempotencyKey.slice(prefix.length);
    if (rxCancelKey(payload.renewalId, newerId) !== message.idempotencyKey) {
      throw new NonRetryableError("REFUSED: malformed cancel key");
    }
    const { events: newer } = await loadStream(deps.sql, renewalStreamId(newerId));
    const supersedes = newer.some(
      (e) =>
        e.type === "RxRenewalQueued" &&
        e.data.supersedes?.some(
          (s) => s.renewalId === payload.renewalId && s.pharmacyId === payload.pharmacyId,
        ),
    );
    const approved = newer.some((e) => e.type === "RenewalApproved" && e.data.by === "clinician");
    if (!supersedes || !approved) {
      throw new NonRetryableError("REFUSED: no clinician-approved renewal supersedes this one");
    }
    const { events: old } = await loadStream(deps.sql, renewalStreamId(payload.renewalId));
    const queued = old.find((e) => e.type === "RxRenewalQueued");
    if (
      !queued ||
      queued.type !== "RxRenewalQueued" ||
      queued.data.pharmacyId !== payload.pharmacyId
    ) {
      throw new NonRetryableError("REFUSED: the renewal was never sent to this pharmacy");
    }
    if (old.some((e) => e.type === "RxCancelAcknowledged")) return; // already cancelled
    const signal = AbortSignal.any([message.signal, AbortSignal.timeout(deps.timeoutMs ?? 10_000)]);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": message.idempotencyKey },
        body: JSON.stringify({
          type: "CancelRx",
          messageId: payload.messageId,
          renewalId: payload.renewalId,
          prescriptionId: payload.prescriptionId,
          pharmacyId: payload.pharmacyId,
          attempt: message.attempt,
        }),
        signal,
      });
    } catch (e) {
      throw new PharmacyRetryableError(`pharmacy request failed: ${String(e)}`);
    }
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text.length > MAX_RESPONSE_BYTES ? OVERSIZE_BODY : JSON.parse(text);
    } catch {
      body = null;
    }
    const outcome = await consumePharmacyResponse(
      deps.sql,
      {
        renewalId: payload.renewalId,
        messageId: payload.messageId,
        idempotencyKey: message.idempotencyKey,
        httpStatus: response.status,
        body,
        kind: "cancel",
      },
      ctxOf("pharmacy:consume-cancel-response"),
    );
    if (outcome.kind === "retry") throw new PharmacyRetryableError(outcome.reason);
    if (outcome.kind === "fatal") throw new NonRetryableError(outcome.reason);
  };
}

export const CANCEL_DEAD_LETTER_CODE = "CANCEL_DEAD_LETTERED";

/** A CancelRx that can never be delivered is flagged on the superseded renewal (once per key). */
export function createCancelDeadLetterHook(sql: Sql): DeadLetterHook {
  return async (m) => {
    const payload = OUTBOX_PAYLOADS["pharmacy.CancelRx"].safeParse(m.payload);
    if (!payload.success) return;
    const renewalId = payload.data.renewalId;
    const messageId = `deadletter:${m.idempotencyKey}`;
    await withConcurrencyRetry(async () => {
      const { events, version } = await loadStream(sql, renewalStreamId(renewalId));
      const handled = events.some(
        (e) =>
          e.type === "RxCancelAcknowledged" ||
          (e.type === "PharmacyErrorReceived" && e.data.messageId === messageId),
      );
      if (handled) return;
      await appendToStream(
        sql,
        renewalStreamId(renewalId),
        version,
        [
          makeEvent("PharmacyErrorReceived", {
            v: 1,
            renewalId,
            messageId,
            code: CANCEL_DEAD_LETTER_CODE,
            retryable: false,
          }),
        ],
        {
          actor: "outbox-worker",
          role: "system",
          action: "pharmacy:cancel-dead-letter",
          detail: { renewalId, idempotencyKey: m.idempotencyKey, error: m.lastError },
        },
      );
    });
  };
}

/** True once the pharmacy answered this key with something final (status, fill, fatal error). */
export function isSettled(events: readonly DomainEvent[], idempotencyKey: string): boolean {
  const transmitted = events.some(
    (e) => e.type === "RxRenewalTransmitted" && e.data.idempotencyKey === idempotencyKey,
  );
  if (!transmitted) {
    // A fill or cancel acknowledgement also settles it, even if the same answer carried a
    // retryable error: never send again after the pharmacy has filled or cancelled.
    return events.some(
      (e) =>
        e.type === "RxFillReceived" ||
        e.type === "RxCancelAcknowledged" ||
        (e.type === "PharmacyErrorReceived" && !e.data.retryable),
    );
  }
  return true;
}
