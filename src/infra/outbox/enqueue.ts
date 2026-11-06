// Same-transaction insert of outbox rows. Imported by the audited append path; it must not import
// from src/infra/audit (that would be a cycle).
import type { Db } from "@/infra/event-store/types";
import {
  InvalidOutboxMessageError,
  validateOutboxMessage,
  type OutboxMessageInput,
  type ValidOutboxMessage,
} from "./messages";

export class DuplicateIdempotencyKeyError extends Error {
  override readonly name = "DuplicateIdempotencyKeyError";
  constructor(readonly idempotencyKey: string) {
    super(`Outbox idempotency key already used: ${idempotencyKey}`);
  }
}

/** Validate everything up front (before any write) and reject duplicate keys within the batch. */
export function validateOutboxBatch(messages: readonly OutboxMessageInput[]): ValidOutboxMessage[] {
  const valid = messages.map((m) => validateOutboxMessage(m));
  const seen = new Set<string>();
  for (const m of valid) {
    if (seen.has(m.idempotencyKey)) {
      throw new InvalidOutboxMessageError(
        `Duplicate idempotency key in batch: ${m.idempotencyKey}`,
      );
    }
    seen.add(m.idempotencyKey);
  }
  return valid;
}

/**
 * Insert validated messages as pending. A reused idempotency key raises
 * DuplicateIdempotencyKeyError, which aborts the surrounding transaction (events and audit too),
 * because a replayed command must not half-apply.
 */
export async function insertOutboxInTx(
  tx: Db,
  messages: readonly ValidOutboxMessage[],
): Promise<void> {
  for (const m of messages) {
    try {
      await tx.unsafe(
        `INSERT INTO outbox (idempotency_key, type, payload) VALUES ($1, $2, $3::text::jsonb)`,
        [m.idempotencyKey, m.type, JSON.stringify(m.payload)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new DuplicateIdempotencyKeyError(m.idempotencyKey);
      }
      throw err;
    }
  }
}
