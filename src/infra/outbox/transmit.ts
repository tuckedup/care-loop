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
import { type DomainEvent } from "@/domain/events";
import { checkTransmittable } from "@/domain/pharmacy-queue";
import { rxStreamId } from "@/domain/patient/patient";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { reviewAggregate } from "@/domain/renewal/review";
import { OUTBOX_PAYLOADS } from "./messages";
import { NonRetryableError, type OutboxHandler } from "./worker";
import { consumePharmacyResponse, type ConsumeOutcome } from "@/domain/renewal/pharmacy-responses";

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
      body = await response.json();
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

/** True once the pharmacy answered this key with something final (status, fill, fatal error). */
export function isSettled(events: readonly DomainEvent[], idempotencyKey: string): boolean {
  const transmitted = events.some(
    (e) => e.type === "RxRenewalTransmitted" && e.data.idempotencyKey === idempotencyKey,
  );
  if (!transmitted) {
    return events.some((e) => e.type === "PharmacyErrorReceived" && !e.data.retryable);
  }
  return true;
}
