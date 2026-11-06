CREATE TABLE "calendar_slots" (
	"slot_id" text PRIMARY KEY NOT NULL,
	"visit_id" text NOT NULL,
	"clinician_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"position" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_up_tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"visit_id" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"position" bigint NOT NULL,
	CONSTRAINT "follow_up_tasks_status_check" CHECK ("follow_up_tasks"."status" in ('requested'))
);
--> statement-breakpoint
CREATE TABLE "visit_schedule" (
	"visit_id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"renewal_id" text,
	"clinician_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"note_id" text,
	"booked_position" bigint NOT NULL,
	CONSTRAINT "visit_schedule_status_check" CHECK ("visit_schedule"."status" in ('booked', 'note_signed'))
);
--> statement-breakpoint
CREATE INDEX "calendar_slots_visit_idx" ON "calendar_slots" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "follow_up_tasks_visit_idx" ON "follow_up_tasks" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_schedule_clinician_idx" ON "visit_schedule" USING btree ("clinician_id","start_at");--> statement-breakpoint
CREATE INDEX "visit_schedule_patient_idx" ON "visit_schedule" USING btree ("patient_id");