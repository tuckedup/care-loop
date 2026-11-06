import {
  ConcurrencyError,
  type Db,
  type ExpectedVersion,
  type NewEvent,
  type StoredEvent,
} from "./types";

interface EventRow {
  global_position: string | number | bigint;
  stream_id: string;
  stream_version: number;
  type: string;
  data: unknown;
  metadata: Record<string, unknown>;
  created_at: string | Date;
}

function toStored(r: EventRow): StoredEvent {
  return {
    globalPosition: BigInt(r.global_position),
    streamId: r.stream_id,
    streamVersion: r.stream_version,
    type: r.type,
    data: r.data,
    metadata: r.metadata,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  };
}

const COLUMNS = `global_position, stream_id, stream_version, type, data, metadata, created_at`;

/** Current version of a stream (0 when it has no events). */
export async function streamVersion(sql: Db, streamId: string): Promise<number> {
  const [row] = await sql<{ v: number | null }[]>`
    SELECT max(stream_version) AS v FROM events WHERE stream_id = ${streamId}
  `;
  return row?.v ?? 0;
}

/** Events of one stream in order. */
export async function readStream(
  sql: Db,
  streamId: string,
  opts: { fromVersion?: number } = {},
): Promise<StoredEvent[]> {
  const from = opts.fromVersion ?? 1;
  const rows = await sql.unsafe<EventRow[]>(
    `SELECT ${COLUMNS} FROM events WHERE stream_id = $1 AND stream_version >= $2
     ORDER BY stream_version ASC`,
    [streamId, from],
  );
  return rows.map(toStored);
}

/** All events with global_position greater than afterPosition, in global order. */
export async function readAll(
  sql: Db,
  opts: { afterPosition?: bigint; limit?: number } = {},
): Promise<StoredEvent[]> {
  const after = (opts.afterPosition ?? 0n).toString();
  const limit = opts.limit ?? 1000;
  const rows = await sql.unsafe<EventRow[]>(
    `SELECT ${COLUMNS} FROM events WHERE global_position > $1::bigint
     ORDER BY global_position ASC LIMIT $2`,
    [after, limit],
  );
  return rows.map(toStored);
}

/**
 * INTERNAL: inserts events inside a transaction the caller already owns.
 * Only src/infra/audit may import this (enforced by a test), because every write must also
 * append an audit entry in the same transaction. Application code uses appendToStream.
 */
export async function insertEventsInTx(
  tx: Db,
  streamId: string,
  expectedVersion: ExpectedVersion,
  events: readonly NewEvent[],
): Promise<StoredEvent[]> {
  if (events.length === 0) return [];
  const current = await streamVersion(tx, streamId);
  if (expectedVersion !== "any" && expectedVersion !== current) {
    throw new ConcurrencyError(streamId, expectedVersion, current);
  }
  const stored: StoredEvent[] = [];
  let version = current;
  for (const e of events) {
    version += 1;
    try {
      // JSON is passed as text and cast: a bare ::jsonb cast makes postgres.js double-encode it.
      const [row] = await tx.unsafe<EventRow[]>(
        `INSERT INTO events (stream_id, stream_version, type, data, metadata)
         VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb)
         RETURNING ${COLUMNS}`,
        [
          streamId,
          version,
          e.type,
          JSON.stringify(e.data ?? null),
          JSON.stringify(e.metadata ?? {}),
        ],
      );
      stored.push(toStored(row!));
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConcurrencyError(streamId, expectedVersion, null);
      }
      throw err;
    }
  }
  return stored;
}

/** Reload-and-retry once on ConcurrencyError; the callback must re-read state each attempt. */
export async function withConcurrencyRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConcurrencyError) return await fn();
    throw err;
  }
}
