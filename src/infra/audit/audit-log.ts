import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { insertEventsInTx } from "@/infra/event-store/store";
import type { Db, ExpectedVersion, NewEvent, StoredEvent } from "@/infra/event-store/types";
import { insertOutboxInTx, validateOutboxBatch } from "@/infra/outbox/enqueue";
import type { OutboxMessageInput } from "@/infra/outbox/messages";
import { canonicalJson } from "./canonical";

export const GENESIS_HASH = "0".repeat(64);

export const AUDIT_ROLES = ["patient", "clinician", "pharmacist", "admin", "system"] as const;

/** Who did what; required for every write. Zod-validated at the boundary. */
export const AuditContextSchema = z.object({
  actor: z.string().min(1).max(200),
  role: z.enum(AUDIT_ROLES),
  action: z.string().min(1).max(200),
  /** Defaults to the stream id for event appends. */
  entity: z.string().min(1).max(300).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AuditContext = z.infer<typeof AuditContextSchema>;

export interface AuditEntry {
  seq: bigint;
  actor: string;
  role: string;
  action: string;
  entity: string;
  detail: Record<string, unknown>;
  /** ISO-8601 UTC with milliseconds; this exact string is what gets hashed. */
  at: string;
  prevHash: string;
  hash: string;
}

type HashedFields = Omit<AuditEntry, "prevHash" | "hash">;

export function computeAuditHash(prevHash: string, f: HashedFields): string {
  const body = canonicalJson({
    seq: f.seq.toString(),
    actor: f.actor,
    role: f.role,
    action: f.action,
    entity: f.entity,
    detail: f.detail,
    at: f.at,
  });
  return createHash("sha256")
    .update(prevHash + body)
    .digest("hex");
}

/**
 * Chain-head locking: every audited write first runs SELECT ... FOR UPDATE on the single
 * audit_chain_head row. That is a transaction-level row lock (safe with the Supabase transaction
 * pooler, unlike session advisory locks), it serializes writers so the chain cannot fork, and
 * because it is taken BEFORE events are inserted, global_position order equals commit order,
 * so projection readers cannot skip a position that commits late.
 */
async function lockChainHead(tx: Db): Promise<{ seq: bigint; hash: string }> {
  const [head] = await tx.unsafe<{ seq: string; hash: string }[]>(
    `SELECT seq, hash FROM audit_chain_head WHERE id = 1 FOR UPDATE`,
  );
  if (!head) throw new Error("audit_chain_head is not initialised (run db:migrate)");
  return { seq: BigInt(head.seq), hash: head.hash };
}

async function writeEntry(
  tx: Db,
  head: { seq: bigint; hash: string },
  ctx: AuditContext,
  entity: string,
  detail: Record<string, unknown>,
): Promise<AuditEntry> {
  const fields: HashedFields = {
    seq: head.seq + 1n,
    actor: ctx.actor,
    role: ctx.role,
    action: ctx.action,
    entity,
    detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
    at: new Date().toISOString(),
  };
  const hash = computeAuditHash(head.hash, fields);
  await tx.unsafe(
    `INSERT INTO audit_log (seq, actor, role, action, entity, detail, at, prev_hash, hash)
     VALUES ($1::bigint, $2, $3, $4, $5, $6::text::jsonb, $7::timestamptz, $8, $9)`,
    [
      fields.seq.toString(),
      fields.actor,
      fields.role,
      fields.action,
      fields.entity,
      JSON.stringify(fields.detail),
      fields.at,
      head.hash,
      hash,
    ],
  );
  await tx.unsafe(`UPDATE audit_chain_head SET seq = $1::bigint, hash = $2 WHERE id = 1`, [
    fields.seq.toString(),
    hash,
  ]);
  return { ...fields, prevHash: head.hash, hash };
}

/**
 * Run arbitrary writes (outbox rows, projections) plus one audit entry in ONE transaction.
 * If `work` or the audit insert throws, everything rolls back.
 */
export async function auditedTransaction<T>(
  sql: Sql,
  rawCtx: AuditContext,
  entity: string,
  work: (tx: Db) => Promise<{ result: T; detail?: Record<string, unknown> }>,
): Promise<{ result: T; audit: AuditEntry }> {
  const ctx = AuditContextSchema.parse(rawCtx);
  return (await sql.begin(async (tx) => {
    const head = await lockChainHead(tx);
    const { result, detail } = await work(tx);
    const audit = await writeEntry(tx, head, ctx, ctx.entity ?? entity, {
      ...ctx.detail,
      ...detail,
    });
    return { result, audit };
  })) as { result: T; audit: AuditEntry };
}

export interface AppendResult {
  events: StoredEvent[];
  audit: AuditEntry;
}

/**
 * THE write path for events: appends events and one audit entry in a single transaction.
 * A ConcurrencyError (or any failure) rolls back both. `outbox` messages are validated, then
 * inserted in the same transaction. `alsoInTx` lets callers add other same-transaction writes.
 */
export async function appendToStream(
  sql: Sql,
  streamId: string,
  expectedVersion: ExpectedVersion,
  events: readonly NewEvent[],
  ctx: AuditContext,
  alsoInTx?: (tx: Db, stored: StoredEvent[]) => Promise<void>,
  outbox: readonly OutboxMessageInput[] = [],
): Promise<AppendResult> {
  if (events.length === 0) throw new Error("appendToStream requires at least one event");
  if (
    process.env.NODE_ENV === "production" &&
    events.some(
      (event) =>
        event.type === "RenewalApproved" &&
        typeof event.data === "object" &&
        event.data !== null &&
        "by" in event.data &&
        event.data.by === "system",
    )
  ) {
    throw new Error("automatic renewals are unavailable in production");
  }
  // Validated before any write: a bad message type/payload/key never opens a transaction.
  const outboxMessages = validateOutboxBatch(outbox);
  const { result, audit } = await auditedTransaction(sql, ctx, streamId, async (tx) => {
    const stored = await insertEventsInTx(tx, streamId, expectedVersion, events);
    if (alsoInTx) await alsoInTx(tx, stored);
    // Same transaction as events + audit: a rollback leaves none of the three.
    await insertOutboxInTx(tx, outboxMessages);
    return {
      result: stored,
      detail: {
        streamId,
        ...(outboxMessages.length > 0
          ? { outbox: outboxMessages.map((m) => ({ type: m.type, key: m.idempotencyKey })) }
          : {}),
        events: stored.map((e) => ({
          type: e.type,
          streamVersion: e.streamVersion,
          globalPosition: e.globalPosition.toString(),
        })),
      },
    };
  });
  return { events: result, audit };
}

export type VerifyResult =
  | { valid: true; checked: number; headSeq: string }
  | { valid: false; checked: number; brokenAtSeq: string; reason: string };

/** Recompute the whole chain; reports the first broken entry. */
export async function verifyAuditChain(sql: Db): Promise<VerifyResult> {
  const rows = await sql.unsafe<
    {
      seq: string;
      actor: string;
      role: string;
      action: string;
      entity: string;
      detail: Record<string, unknown>;
      at: string;
      prev_hash: string;
      hash: string;
    }[]
  >(
    `SELECT seq, actor, role, action, entity, detail,
            to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
            prev_hash, hash
     FROM audit_log ORDER BY seq ASC`,
  );
  let prev = GENESIS_HASH;
  let expectedSeq = 1n;
  let checked = 0;
  for (const r of rows) {
    const seq = BigInt(r.seq);
    const fail = (reason: string): VerifyResult => ({
      valid: false,
      checked,
      brokenAtSeq: r.seq,
      reason,
    });
    if (seq !== expectedSeq) return fail(`expected seq ${expectedSeq}, found ${seq}`);
    if (r.prev_hash !== prev) return fail("prev_hash does not match previous entry hash");
    const recomputed = computeAuditHash(prev, {
      seq,
      actor: r.actor,
      role: r.role,
      action: r.action,
      entity: r.entity,
      detail: r.detail,
      at: r.at,
    });
    if (recomputed !== r.hash) return fail("hash mismatch (entry content was altered)");
    prev = r.hash;
    expectedSeq += 1n;
    checked += 1;
  }
  const [head] = await sql.unsafe<{ seq: string; hash: string }[]>(
    `SELECT seq, hash FROM audit_chain_head WHERE id = 1`,
  );
  if (!head || BigInt(head.seq) !== BigInt(checked) || head.hash !== prev) {
    return {
      valid: false,
      checked,
      brokenAtSeq: String(checked),
      reason: "chain head does not match last entry (entries removed or head altered)",
    };
  }
  return { valid: true, checked, headSeq: head.seq };
}
