// Surfaces renewals that the pharmacy accepted but never filled (review item 3). A renewal in
// queued / transmitted / pharmacy_status whose last event is older than the stale threshold gets
// one non-retryable PharmacyErrorReceived{code: STALLED_NO_FILL}: rx_status shows a problem, the
// clinician and pharmacist see an alert, and the patient may renew again. A later RxFill still
// wins (filled beats a fatal error). The clock is injected; the threshold is a demo configuration
// value, not a clinical one (TODO: source needed for a real value).
import type { Sql } from "postgres";
import { loadStream } from "@/domain/aggregate-handler";
import { makeEvent } from "@/domain/events";
import { APPROVED_NOT_SENT_CODE, STALLED_CODE } from "@/domain/pharmacy-stall";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { appendToStream } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";

/** Call after the rx_status projection is up to date. Returns how many alerts were raised. */
export async function sweepStalledRenewals(
  sql: Sql,
  opts: { now: Date; staleHours: number; unsentMinutes?: number },
): Promise<number> {
  return (await sweepStalled(sql, opts)) + (await sweepApprovedNotSent(sql, opts));
}

/**
 * Defence in depth: a renewal approved WITH a confirmed pharmacy that has no RxRenewalQueued after
 * N minutes (default 15, a demo value) is flagged APPROVED_NOT_SENT. The normal path cannot produce
 * it (Approve queues in the same append); it catches forged or legacy states. Renewals approved
 * without any pharmacy selection (old seed history) are deliberately not flagged.
 */
async function sweepApprovedNotSent(
  sql: Sql,
  opts: { now: Date; unsentMinutes?: number },
): Promise<number> {
  const cutoff = new Date(opts.now.getTime() - (opts.unsentMinutes ?? 15) * 60_000);
  const rows = await sql.unsafe<{ renewal_id: string }[]>(
    `SELECT r.renewal_id FROM rx_status r
     WHERE r.status = 'approved' AND r.updated_at < $1::timestamptz
       AND EXISTS (SELECT 1 FROM events e WHERE e.stream_id = 'renewal-' || r.renewal_id
                   AND e.type = 'PharmacySelected')
     ORDER BY r.last_position ASC LIMIT 200`,
    [cutoff.toISOString()],
  );
  let raised = 0;
  for (const { renewal_id: renewalId } of rows) {
    const messageId = `unsent:${renewalId}`;
    const did = await withConcurrencyRetry(async () => {
      const { events, version } = await loadStream(sql, renewalStreamId(renewalId));
      if (
        events.some((e) => e.type === "RxRenewalQueued") ||
        events.some((e) => e.type === "PharmacyErrorReceived" && e.data.messageId === messageId)
      ) {
        return false;
      }
      await appendToStream(
        sql,
        renewalStreamId(renewalId),
        version,
        [
          makeEvent("PharmacyErrorReceived", {
            v: 1,
            renewalId,
            messageId,
            code: APPROVED_NOT_SENT_CODE,
            retryable: false,
          }),
        ],
        {
          actor: "outbox-worker",
          role: "system",
          action: "pharmacy:approved-not-sent",
          detail: { renewalId, asOf: opts.now.toISOString() },
        },
      );
      return true;
    });
    if (did) raised += 1;
  }
  return raised;
}

async function sweepStalled(sql: Sql, opts: { now: Date; staleHours: number }): Promise<number> {
  const cutoff = new Date(opts.now.getTime() - opts.staleHours * 3_600_000);
  const rows = await sql.unsafe<{ renewal_id: string }[]>(
    `SELECT renewal_id FROM rx_status
     WHERE status IN ('queued', 'transmitted', 'pharmacy_status') AND updated_at < $1::timestamptz
     ORDER BY last_position ASC LIMIT 200`,
    [cutoff.toISOString()],
  );
  let raised = 0;
  for (const { renewal_id: renewalId } of rows) {
    const messageId = `stalled:${renewalId}`;
    const did = await withConcurrencyRetry(async () => {
      const { events, version } = await loadStream(sql, renewalStreamId(renewalId));
      const settled = events.some(
        (e) =>
          e.type === "RxFillReceived" ||
          e.type === "RxCancelAcknowledged" ||
          (e.type === "PharmacyErrorReceived" &&
            (!e.data.retryable || e.data.messageId === messageId)),
      );
      if (settled) return false;
      await appendToStream(
        sql,
        renewalStreamId(renewalId),
        version,
        [
          makeEvent("PharmacyErrorReceived", {
            v: 1,
            renewalId,
            messageId,
            code: STALLED_CODE,
            retryable: false,
          }),
        ],
        {
          actor: "outbox-worker",
          role: "system",
          action: "pharmacy:stalled",
          detail: { renewalId, staleHours: opts.staleHours, asOf: opts.now.toISOString() },
        },
      );
      return true;
    });
    if (did) raised += 1;
  }
  return raised;
}
