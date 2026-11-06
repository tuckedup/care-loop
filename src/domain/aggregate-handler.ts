// Command handler: load stream -> decide -> append (events + audit entry in ONE transaction).
// The only persistence path is appendToStream; there is no unaudited variant.
import type { Sql } from "postgres";
import { appendToStream, type AuditContext, type AppendResult } from "@/infra/audit";
import { readStream, withConcurrencyRetry } from "@/infra/event-store";
import { replay, type Aggregate } from "./aggregate";
import { makeEvent, parseEvent, type DomainEvent } from "./events";

export interface HandleResult {
  /** Empty when the command decided there was nothing to do. */
  appended: AppendResult | null;
  version: number;
}

/** Load and validate a stream into domain events. */
export async function loadStream(
  sql: Sql,
  streamId: string,
): Promise<{ events: DomainEvent[]; version: number }> {
  const stored = await readStream(sql, streamId);
  return {
    events: stored.map((s) => parseEvent({ type: s.type, data: s.data })),
    version: stored.length === 0 ? 0 : stored[stored.length - 1]!.streamVersion,
  };
}

/**
 * Executes one command. On a ConcurrencyError the stream is reloaded and the command decided
 * again exactly once; a second conflict (or a DomainError on the fresh state) is surfaced.
 */
export async function handleCommand<State, Command>(
  sql: Sql,
  aggregate: Aggregate<State, Command>,
  streamId: string,
  command: Command,
  ctx: AuditContext,
): Promise<HandleResult> {
  return withConcurrencyRetry(async () => {
    const { events: history, version } = await loadStream(sql, streamId);
    const state = replay(aggregate, history);
    const decided = aggregate.decide(state, command);
    if (decided.length === 0) return { appended: null, version };
    const appended = await appendToStream(
      sql,
      streamId,
      version,
      decided.map((e) => makeEvent(e.type, e.data as never)),
      ctx,
    );
    return { appended, version: version + decided.length };
  });
}
