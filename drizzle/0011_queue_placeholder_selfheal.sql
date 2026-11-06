-- A placeholder row (schema-invalid RenewalRequested) has no patient or prescription.
ALTER TABLE "renewal_queue" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "renewal_queue" ALTER COLUMN "prescription_id" DROP NOT NULL;--> statement-breakpoint
-- Self-heal after migrations 0009-0011: renewal_queue and phq9_trend are rebuildable projections
-- whose rules and keys changed. Clearing them AND their checkpoints makes the projection runner
-- replay from position 0 on its next run (`pnpm projections:rebuild` does the same on demand).
-- Events and the audit log are never touched.
TRUNCATE "renewal_queue";--> statement-breakpoint
TRUNCATE "phq9_trend";--> statement-breakpoint
DELETE FROM "projection_checkpoints" WHERE "name" IN ('renewal_queue', 'phq9_trend');--> statement-breakpoint
DELETE FROM "projection_anomalies" WHERE "projection" IN ('renewal_queue', 'phq9_trend');
