CREATE TABLE "pharmacy_alerts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"renewal_id" text NOT NULL,
	"patient_id" text,
	"kind" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"raised_position" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "pharmacy_alerts_kind_check" CHECK ("pharmacy_alerts"."kind" in ('escalation', 'error', 'cancel')),
	CONSTRAINT "pharmacy_alerts_status_check" CHECK ("pharmacy_alerts"."status" in ('open', 'acknowledged'))
);
--> statement-breakpoint
CREATE INDEX "pharmacy_alerts_status_idx" ON "pharmacy_alerts" USING btree ("status","raised_position");--> statement-breakpoint
CREATE INDEX "pharmacy_alerts_renewal_idx" ON "pharmacy_alerts" USING btree ("renewal_id");