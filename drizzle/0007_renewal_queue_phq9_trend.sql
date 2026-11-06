CREATE TABLE "phq9_trend" (
	"renewal_id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"phq9_total" integer,
	"gad7_total" integer,
	"item9" integer,
	"position" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_queue" (
	"renewal_id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"prescription_id" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"escalated" boolean DEFAULT false NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_signal_count" integer DEFAULT 0 NOT NULL,
	"clinician_id" text,
	"decision" text,
	"decided_by" text,
	"requested_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_position" bigint NOT NULL,
	CONSTRAINT "renewal_queue_status_check" CHECK ("renewal_queue"."status" in ('requested', 'in-progress', 'completed'))
);
--> statement-breakpoint
CREATE INDEX "phq9_trend_patient_idx" ON "phq9_trend" USING btree ("patient_id","position");--> statement-breakpoint
CREATE INDEX "renewal_queue_status_idx" ON "renewal_queue" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "renewal_queue_patient_idx" ON "renewal_queue" USING btree ("patient_id");