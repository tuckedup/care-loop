CREATE TABLE "patient_med_list" (
	"prescription_id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"rxcui" text NOT NULL,
	"drug_name" text NOT NULL,
	"dose_mg" double precision NOT NULL,
	"frequency" jsonb NOT NULL,
	"status" text NOT NULL,
	"dose_changed" boolean DEFAULT false NOT NULL,
	"prescribed_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"last_position" bigint NOT NULL,
	CONSTRAINT "patient_med_list_status_check" CHECK ("patient_med_list"."status" in ('active', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "rx_status" (
	"renewal_id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"prescription_id" text NOT NULL,
	"status" text NOT NULL,
	"pharmacy_status" text,
	"last_event_type" text NOT NULL,
	"last_position" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "patient_med_list_patient_idx" ON "patient_med_list" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "rx_status_prescription_idx" ON "rx_status" USING btree ("prescription_id");