// Race-safe "request a renewal" (review item 4). Two tabs (or two requests) for the same
// prescription must not both create a renewal while one is in flight.
//
// The check runs INSIDE the append transaction (alsoInTx). appendToStream takes a row lock on the
// single audit_chain_head row before it inserts anything, which serialises every audited write; a
// competing request therefore waits for the first to commit and then SEES it. This is a
// transaction-level row lock (no session-level advisory locks), safe with the Supabase transaction
// pooler. If the competitor is resumable the caller resumes it; if it is in flight the request is
// refused; either way nothing is written (the whole transaction rolls back).
import type { Sql } from "postgres";
import { appendToStream, type AuditContext } from "@/infra/audit";
import { readStream } from "@/infra/event-store";
import { foldRxStatus } from "@/infra/projections/rx-status";
import { DomainError } from "../aggregate";
import { makeEvent } from "../events";
import { DEFAULT_STALE_HOURS, isInFlight } from "../pharmacy-stall";
import { renewalAggregate, renewalStreamId, type RequestRenewal } from "./renewal";

export class RenewalConflictError extends Error {
  override readonly name = "RenewalConflictError";
  constructor(
    readonly kind: "resume" | "in_flight",
    /** The competing renewal (and its rx_status), when known. */
    readonly renewalId: string | null,
    readonly status: string | null,
  ) {
    super(kind === "resume" ? "an open renewal exists" : "a renewal is already in progress");
  }
}

const RESUMABLE = new Set(["requested", "identity_verified"]);

export async function requestRenewalExclusive(
  sql: Sql,
  command: RequestRenewal,
  ctx: AuditContext,
  opts: { now: Date; staleHours?: number },
) {
  const decided = renewalAggregate.decide(renewalAggregate.initialState, command);
  if (decided.length === 0) throw new DomainError("INVALID_COMMAND", "nothing to request");
  const ownStream = renewalStreamId(command.renewalId);
  return appendToStream(
    sql,
    ownStream,
    0,
    decided.map((e) => makeEvent(e.type, e.data as never)),
    ctx,
    async (tx) => {
      const others = await tx.unsafe<{ stream_id: string }[]>(
        `SELECT DISTINCT stream_id FROM events
         WHERE type = 'RenewalRequested' AND data->>'prescriptionId' = $1 AND stream_id <> $2`,
        [command.prescriptionId, ownStream],
      );
      let blocker: RenewalConflictError | null = null;
      for (const o of others) {
        const row = foldRxStatus(await readStream(tx, o.stream_id));
        // An unreadable renewal counts as in flight (fail closed).
        if (row === null) {
          blocker ??= new RenewalConflictError("in_flight", null, null);
          continue;
        }
        if (RESUMABLE.has(row.status)) {
          throw new RenewalConflictError("resume", row.renewalId, row.status);
        }
        if (
          isInFlight(row, { now: opts.now, staleHours: opts.staleHours ?? DEFAULT_STALE_HOURS })
        ) {
          blocker ??= new RenewalConflictError("in_flight", row.renewalId, row.status);
        }
      }
      if (blocker) throw blocker;
    },
  );
}
