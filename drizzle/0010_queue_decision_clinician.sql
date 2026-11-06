-- renewal_queue / phq9_trend are rebuildable projections. After applying migrations 0009 and 0010
-- run `pnpm projections:rebuild`: migration 0009 added request_position with DEFAULT 0 and this
-- migration adds decision_clinician_id, so existing rows are only fully correct after a replay.
ALTER TABLE "renewal_queue" ADD COLUMN "decision_clinician_id" text;--> statement-breakpoint
-- Best-effort backfill of the immutable ordering key until the rebuild runs.
UPDATE "renewal_queue" q SET "request_position" = e.p
FROM (SELECT stream_id, min(global_position) AS p FROM events
      WHERE type = 'RenewalRequested' GROUP BY stream_id) e
WHERE e.stream_id = 'renewal-' || q.renewal_id AND q.request_position = 0;
