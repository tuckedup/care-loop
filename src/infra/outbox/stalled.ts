// Surfaces renewals that the pharmacy accepted but never filled (review item 3). A renewal in
// queued / transmitted / pharmacy_status whose last event is older than the stale threshold gets
// one non-retryable PharmacyErrorReceived{code: STALLED_NO_FILL}: rx_status shows a problem, the
// clinician and pharmacist see an alert, and the patient may renew again. A later RxFill still
// wins (filled beats a fatal error). The clock is injected; the threshold is a demo configuration
// value, not a clinical one (TODO: source needed for a real value).
import type { Sql } from "postgres";
import { loadStream } from "@/domain/aggregate-handler";
import { makeEvent } from "@/domain/events";
import { STALLED_CODE } from "@/domain/pharmacy-stall";
import { renewalStreamId } from "@/domain/renewal/renewal";
import { appendToStream } from "@/infra/audit";
import { withConcurrencyRetry } from "@/infra/event-store";

/** Call after the rx_status projection is up to date. Returns how many alerts were raised. */
export async function sweepStalledRenewals(
  sql: Sql,
  opts: { now: Date; staleHours: number },
): Promise<number> {
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
