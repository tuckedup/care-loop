// Outbox message vocabulary. Every message has a type with a Zod payload schema and a unique
// idempotency key; external calls are made by handlers (see worker.ts) and must pass that key on.
// Pharmacy message names follow the SCRIPT-style vocabulary in docs/SPEC.md section 7.
import { z } from "zod";

const id = z.string().min(1).max(200);

export const OUTBOX_PAYLOADS = {
  "pharmacy.NewRx": z.object({
    renewalId: id,
    prescriptionId: id,
    pharmacyId: z.string().regex(/^[0-9]{7}$/, "pharmacy id must be exactly 7 digits"),
    messageId: id,
  }),
  /** Approved renewal sent to the pharmacy (SCRIPT-style RxRenewalResponse, F048). */
  "pharmacy.RxRenewalResponse": z.object({
    renewalId: id,
    prescriptionId: id,
    pharmacyId: z.string().regex(/^[0-9]{7}$/, "pharmacy id must be exactly 7 digits"),
    messageId: id,
    response: z.literal("Approved"),
  }),
  "pharmacy.CancelRx": z.object({
    renewalId: id,
    prescriptionId: id,
    pharmacyId: z.string().regex(/^[0-9]{7}$/, "pharmacy id must be exactly 7 digits"),
    messageId: id,
  }),
} as const;

export type OutboxType = keyof typeof OUTBOX_PAYLOADS;
export const OUTBOX_TYPES = Object.keys(OUTBOX_PAYLOADS) as OutboxType[];

export class InvalidOutboxMessageError extends Error {
  override readonly name = "InvalidOutboxMessageError";
}

const InputBase = z.object({
  type: z.string().min(1).max(100),
  idempotencyKey: z.string().min(1).max(200),
  payload: z.unknown(),
});

export interface OutboxMessageInput {
  type: OutboxType;
  idempotencyKey: string;
  payload: unknown;
}

export interface ValidOutboxMessage {
  type: OutboxType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Validates type, key and payload. Unknown types are rejected (fail closed). */
export function validateOutboxMessage(input: unknown): ValidOutboxMessage {
  const base = InputBase.safeParse(input);
  if (!base.success)
    throw new InvalidOutboxMessageError(`Invalid outbox message: ${base.error.message}`);
  const { type, idempotencyKey, payload } = base.data;
  if (!Object.hasOwn(OUTBOX_PAYLOADS, type)) {
    throw new InvalidOutboxMessageError(`Unknown outbox message type: ${type}`);
  }
  const parsed = OUTBOX_PAYLOADS[type as OutboxType].safeParse(payload);
  if (!parsed.success) {
    throw new InvalidOutboxMessageError(`Invalid payload for ${type}: ${parsed.error.message}`);
  }
  return { type: type as OutboxType, idempotencyKey, payload: parsed.data };
}
