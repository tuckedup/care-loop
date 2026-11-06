// Outbox worker. Transaction-pooler safe: every step is a single statement or a short transaction;
// no LISTEN/NOTIFY and no session-level advisory locks. Concurrency control is
// FOR UPDATE SKIP LOCKED inside the claiming UPDATE, plus a lease that a reaper can expire.
//
// Delivery semantics are at-least-once: a handler may run again after a crash or lease expiry, so
// every handler receives the message's idempotencyKey and must pass it to the external system.
import type { Sql } from "postgres";
import { auditedTransaction } from "@/infra/audit";
import { OUTBOX_PAYLOADS, type OutboxType } from "./messages";

export const DEFAULT_MAX_ATTEMPTS = 5;

export interface ClaimedMessage {
  id: bigint;
  idempotencyKey: string;
  type: OutboxType;
  payload: Record<string, unknown>;
  /** 1-based number of this delivery attempt (incremented when the message is claimed). */
  attempt: number;
}

export interface HandlerContext extends ClaimedMessage {
  /** Aborts when the lease is about to expire, so a slow handler cannot outlive its lease. */
  signal: AbortSignal;
}

export type OutboxHandler = (message: HandlerContext) => Promise<void>;

/** Throw from a handler for failures that retrying cannot fix: the message is dead-lettered. */
export class NonRetryableError extends Error {
  override readonly name = "NonRetryableError";
}

/** A dead-lettered message, as handed to a dead-letter hook. */
export interface DeadMessage {
  id: bigint;
  idempotencyKey: string;
  type: OutboxType;
  payload: Record<string, unknown>;
  lastError: string | null;
  attempts: number;
}

/**
 * Runs for dead-lettered messages of one type, on every worker pass, so a failure that can never
 * be retried is surfaced to people instead of leaving the business state silently stranded. It MUST
 * be idempotent (it sees the same dead row on every pass until its effect exists) and must not throw
 * for expected conditions; unexpected errors are counted and retried on the next pass.
 */
export type DeadLetterHook = (message: DeadMessage) => Promise<void>;

export class HandlerRegistry {
  private readonly handlers = new Map<OutboxType, OutboxHandler>();
  private readonly deadHooks = new Map<OutboxType, DeadLetterHook>();
  registerDeadLetter(type: OutboxType, hook: DeadLetterHook): this {
    if (this.deadHooks.has(type)) throw new Error(`Dead-letter hook already registered: ${type}`);
    this.deadHooks.set(type, hook);
    return this;
  }
  deadLetterTypes(): OutboxType[] {
    return [...this.deadHooks.keys()];
  }
  deadLetterHook(type: string): DeadLetterHook | undefined {
    return this.deadHooks.get(type as OutboxType);
  }
  register(type: OutboxType, handler: OutboxHandler): this {
    if (this.handlers.has(type)) throw new Error(`Outbox handler already registered: ${type}`);
    this.handlers.set(type, handler);
    return this;
  }
  get(type: string): OutboxHandler | undefined {
    return this.handlers.get(type as OutboxType);
  }
  types(): OutboxType[] {
    return [...this.handlers.keys()];
  }
}

export interface WorkerConfig {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  leaseMs: number;
  batchSize: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  backoffBaseMs: 1_000,
  backoffCapMs: 5 * 60_000,
  leaseMs: 60_000,
  batchSize: 10,
};

export interface WorkerDeps {
  registry: HandlerRegistry;
  /** Float in [0, 1). Injected so backoff jitter is deterministic in tests and seeded runs. */
  rng: () => number;
  now?: () => Date;
  config?: Partial<WorkerConfig>;
}

/**
 * Exponential backoff with equal jitter: the delay for the Nth failed attempt is
 * min(cap, base * 2^(N-1)), scaled into [50%, 100%] by the injected RNG.
 */
export function computeBackoffMs(
  attempt: number,
  cfg: Pick<WorkerConfig, "backoffBaseMs" | "backoffCapMs">,
  rng: () => number,
): number {
  const exp = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + 0.5 * rng()));
}

interface ClaimRow {
  id: string;
  idempotency_key: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Claim up to `limit` due messages of the given types in ONE statement. SKIP LOCKED means
 * concurrent claimers take disjoint rows without waiting. Attempts are counted at claim time,
 * so a worker that crashes mid-handler still consumes an attempt.
 */
export async function claimBatch(
  sql: Sql,
  opts: { types: readonly string[]; limit: number; leaseMs: number; now: Date },
): Promise<ClaimedMessage[]> {
  if (opts.types.length === 0) return [];
  const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
  const rows = await sql.unsafe<ClaimRow[]>(
    `UPDATE outbox SET status = 'processing', lease_until = $1::timestamptz,
            attempts = attempts + 1, updated_at = $2::timestamptz
     WHERE id IN (
       SELECT id FROM outbox
       WHERE status = 'pending' AND next_attempt_at <= $2::timestamptz AND type = ANY($3::text[])
       ORDER BY next_attempt_at, id
       LIMIT $4
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, idempotency_key, type, payload, attempts`,
    [leaseUntil.toISOString(), opts.now.toISOString(), opts.types as string[], opts.limit],
  );
  return rows
    .map((r) => ({
      id: BigInt(r.id),
      idempotencyKey: r.idempotency_key,
      type: r.type as OutboxType,
      payload: r.payload,
      attempt: r.attempts,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

const audit = (action: string) => ({ actor: "outbox-worker", role: "system" as const, action });

/**
 * Return expired leases to pending (the worker presumably crashed). A message that has already
 * used its last attempt is dead-lettered instead of retried forever. Audited when anything moved.
 */
export async function reapExpiredLeases(
  sql: Sql,
  opts: { now: Date; maxAttempts: number },
): Promise<{ requeued: number; dead: number }> {
  const [due] = await sql.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM outbox WHERE status = 'processing' AND lease_until < $1::timestamptz`,
    [opts.now.toISOString()],
  );
  if (Number(due!.n) === 0) return { requeued: 0, dead: 0 };
  const { result } = await auditedTransaction(sql, audit("outbox.reap"), "outbox", async (tx) => {
    const rows = await tx.unsafe<{ idempotency_key: string; status: string }[]>(
      `UPDATE outbox SET
         status = CASE WHEN attempts >= $2 THEN 'dead' ELSE 'pending' END,
         next_attempt_at = $1::timestamptz, lease_until = NULL,
         last_error = 'lease expired before the handler finished', updated_at = $1::timestamptz
       WHERE status = 'processing' AND lease_until < $1::timestamptz
       RETURNING idempotency_key, status`,
      [opts.now.toISOString(), opts.maxAttempts],
    );
    const dead = rows.filter((r) => r.status === "dead");
    return {
      result: { requeued: rows.length - dead.length, dead: dead.length },
      detail: {
        requeued: rows.length - dead.length,
        deadKeys: dead.map((r) => r.idempotency_key),
      },
    };
  });
  return result;
}

const truncate = (s: string) => (s.length > 1000 ? `${s.slice(0, 1000)}...` : s);
const messageOf = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Mark done. Guarded by (status, attempts) so a worker that lost its lease cannot overwrite. */
async function markDone(sql: Sql, m: ClaimedMessage, now: Date): Promise<boolean> {
  const { result } = await auditedTransaction(
    sql,
    audit("outbox.done"),
    `outbox:${m.idempotencyKey}`,
    async (tx) => {
      const rows = await tx.unsafe(
        `UPDATE outbox SET status = 'done', lease_until = NULL, last_error = NULL,
                updated_at = $3::timestamptz
         WHERE id = $1::bigint AND status = 'processing' AND attempts = $2 RETURNING id`,
        [m.id.toString(), m.attempt, now.toISOString()],
      );
      return {
        result: rows.length === 1,
        detail: { type: m.type, attempt: m.attempt, applied: rows.length === 1 },
      };
    },
  );
  return result;
}

async function markFailed(
  sql: Sql,
  m: ClaimedMessage,
  err: unknown,
  deps: { now: Date; rng: () => number; cfg: WorkerConfig },
): Promise<"retry" | "dead" | "lost"> {
  const dead = err instanceof NonRetryableError || m.attempt >= deps.cfg.maxAttempts;
  const error = truncate(messageOf(err));
  if (!dead) {
    const next = new Date(deps.now.getTime() + computeBackoffMs(m.attempt, deps.cfg, deps.rng));
    const rows = await sql.unsafe(
      `UPDATE outbox SET status = 'pending', lease_until = NULL, last_error = $3,
              next_attempt_at = $4::timestamptz, updated_at = $5::timestamptz
       WHERE id = $1::bigint AND status = 'processing' AND attempts = $2 RETURNING id`,
      [m.id.toString(), m.attempt, error, next.toISOString(), deps.now.toISOString()],
    );
    return rows.length === 1 ? "retry" : "lost";
  }
  const { result } = await auditedTransaction(
    sql,
    audit("outbox.dead"),
    `outbox:${m.idempotencyKey}`,
    async (tx) => {
      const rows = await tx.unsafe(
        `UPDATE outbox SET status = 'dead', lease_until = NULL, last_error = $3,
                updated_at = $4::timestamptz
         WHERE id = $1::bigint AND status = 'processing' AND attempts = $2 RETURNING id`,
        [m.id.toString(), m.attempt, error, deps.now.toISOString()],
      );
      return {
        result: rows.length === 1 ? ("dead" as const) : ("lost" as const),
        detail: { type: m.type, attempt: m.attempt, error },
      };
    },
  );
  return result;
}

export interface RunStats {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
  /** Finished after the lease was lost to the reaper; another delivery owns the message now. */
  lost: number;
  reaped: { requeued: number; dead: number };
  /** Dead-letter hooks run this pass (idempotent; most are no-ops after the first pass). */
  deadLetterHooks: number;
  deadLetterHookErrors: number;
}

/** One worker pass: reap expired leases, claim a batch, run handlers, record outcomes. */
export async function runOnce(sql: Sql, deps: WorkerDeps): Promise<RunStats> {
  const cfg = { ...DEFAULT_WORKER_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());
  const stats: RunStats = {
    claimed: 0,
    done: 0,
    retried: 0,
    dead: 0,
    lost: 0,
    deadLetterHooks: 0,
    deadLetterHookErrors: 0,
    reaped: await reapExpiredLeases(sql, { now: now(), maxAttempts: cfg.maxAttempts }),
  };
  const batch = await claimBatch(sql, {
    types: deps.registry.types(),
    limit: cfg.batchSize,
    leaseMs: cfg.leaseMs,
    now: now(),
  });
  stats.claimed = batch.length;
  for (const m of batch) {
    let failure: unknown = null;
    try {
      // Re-validate at the boundary: never hand a handler an unchecked payload.
      const parsed = OUTBOX_PAYLOADS[m.type].safeParse(m.payload);
      if (!parsed.success) {
        throw new NonRetryableError(`Invalid stored payload: ${parsed.error.message}`);
      }
      const handler = deps.registry.get(m.type);
      if (!handler) throw new NonRetryableError(`No handler for ${m.type}`);
      await handler({
        ...m,
        payload: parsed.data,
        signal: AbortSignal.timeout(Math.max(1, cfg.leaseMs - 1_000)),
      });
    } catch (e) {
      failure = e ?? new Error("unknown handler failure");
    }
    if (failure === null) {
      if (await markDone(sql, m, now())) stats.done += 1;
      else stats.lost += 1;
    } else {
      const outcome = await markFailed(sql, m, failure, { now: now(), rng: deps.rng, cfg });
      if (outcome === "retry") stats.retried += 1;
      else if (outcome === "dead") stats.dead += 1;
      else stats.lost += 1;
    }
  }
  // Surface dead-lettered messages (this pass's and earlier ones, e.g. reaped) to people.
  const hooked = deps.registry.deadLetterTypes();
  if (hooked.length > 0) {
    const dead = await sql.unsafe<
      {
        id: string;
        idempotency_key: string;
        type: string;
        payload: Record<string, unknown>;
        last_error: string | null;
        attempts: number;
      }[]
    >(
      `SELECT id, idempotency_key, type, payload, last_error, attempts FROM outbox
       WHERE status = 'dead' AND type = ANY($1::text[]) ORDER BY id DESC LIMIT 200`,
      [hooked as string[]],
    );
    for (const d of dead) {
      const hook = deps.registry.deadLetterHook(d.type);
      if (!hook) continue;
      try {
        await hook({
          id: BigInt(d.id),
          idempotencyKey: d.idempotency_key,
          type: d.type as OutboxType,
          payload: d.payload,
          lastError: d.last_error,
          attempts: d.attempts,
        });
        stats.deadLetterHooks += 1;
      } catch {
        stats.deadLetterHookErrors += 1;
      }
    }
  }
  return stats;
}
