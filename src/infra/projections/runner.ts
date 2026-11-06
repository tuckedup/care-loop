import type { Sql } from "postgres";
import { readAll } from "@/infra/event-store";
import type { Db, StoredEvent } from "@/infra/event-store/types";

/**
 * A read model built from the event log. `handle` runs inside the runner's transaction, so its
 * writes and the checkpoint move together. Handlers must be deterministic functions of the event
 * (and the projection's own tables) so a rebuild from position 0 gives the same result.
 */
export interface Projection {
  /** Unique, stable name; also the checkpoint key. */
  readonly name: string;
  handle(tx: Db, event: StoredEvent): Promise<void>;
  /** Empty the projection's own tables (used by rebuild). Never touches events. */
  reset(tx: Db): Promise<void>;
}

export interface RunResult {
  applied: number;
  lastPosition: bigint;
}

export async function getCheckpoint(sql: Db, name: string): Promise<bigint> {
  const [row] = await sql.unsafe<{ last_position: string }[]>(
    `SELECT last_position FROM projection_checkpoints WHERE name = $1`,
    [name],
  );
  return row ? BigInt(row.last_position) : 0n;
}

/**
 * Apply events after the checkpoint, in global order, batch by batch. Each batch is one
 * transaction: lock the checkpoint row (concurrent runners serialize), re-read the checkpoint,
 * apply, advance. Already-applied positions are never re-read, and a failing handler rolls the
 * batch back and leaves the checkpoint untouched.
 */
export async function runProjection(
  sql: Sql,
  projection: Projection,
  opts: { batchSize?: number } = {},
): Promise<RunResult> {
  const batchSize = opts.batchSize ?? 200;
  let applied = 0;
  let last = 0n;
  for (;;) {
    const batch = await sql.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, 0)
         ON CONFLICT (name) DO NOTHING`,
        [projection.name],
      );
      const [row] = await tx.unsafe<{ last_position: string }[]>(
        `SELECT last_position FROM projection_checkpoints WHERE name = $1 FOR UPDATE`,
        [projection.name],
      );
      const from = BigInt(row!.last_position);
      const events = await readAll(tx, { afterPosition: from, limit: batchSize });
      let position = from;
      for (const event of events) {
        if (event.globalPosition <= position) continue; // idempotency guard
        await projection.handle(tx, event);
        position = event.globalPosition;
      }
      if (position !== from) {
        await tx.unsafe(
          `UPDATE projection_checkpoints SET last_position = $2::bigint, updated_at = now()
           WHERE name = $1`,
          [projection.name, position.toString()],
        );
      }
      return { count: events.length, position };
    });
    applied += batch.count;
    last = batch.position;
    if (batch.count < batchSize) break;
  }
  return { applied, lastPosition: last };
}
