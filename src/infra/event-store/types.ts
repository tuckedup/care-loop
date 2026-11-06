import type { Sql, TransactionSql } from "postgres";

/** A pool connection or an open transaction. */
export type Db = Sql | TransactionSql;

/** Event as supplied by a caller. Payload validation happens in src/domain/events.ts. */
export interface NewEvent {
  type: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export interface StoredEvent {
  globalPosition: bigint;
  streamId: string;
  streamVersion: number;
  type: string;
  data: unknown;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Version the caller believes the stream is at. 0 means "the stream must not exist yet".
 * "any" skips the check (use only for streams where order does not matter).
 */
export type ExpectedVersion = number | "any";

/** Thrown when the stream moved since the caller read it. Reload, decide again, retry. */
export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
  constructor(
    readonly streamId: string,
    readonly expectedVersion: ExpectedVersion,
    readonly actualVersion: number | null,
  ) {
    super(
      `Concurrency conflict on ${streamId}: expected version ${String(expectedVersion)}, ` +
        `actual ${actualVersion === null ? "unknown (concurrent insert)" : actualVersion}`,
    );
  }
}
