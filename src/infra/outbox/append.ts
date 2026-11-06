import type { Sql } from "postgres";
import { appendToStream, type AppendResult, type AuditContext } from "@/infra/audit";
import type { ExpectedVersion, NewEvent } from "@/infra/event-store/types";
import type { OutboxMessageInput } from "./messages";

/**
 * Append events and enqueue outbox messages atomically (events + outbox + one audit entry in a
 * single transaction). If anything fails, none of them exist afterwards.
 */
export function appendWithOutbox(
  sql: Sql,
  streamId: string,
  expectedVersion: ExpectedVersion,
  events: readonly NewEvent[],
  outbox: readonly OutboxMessageInput[],
  ctx: AuditContext,
): Promise<AppendResult> {
  return appendToStream(sql, streamId, expectedVersion, events, ctx, undefined, outbox);
}
