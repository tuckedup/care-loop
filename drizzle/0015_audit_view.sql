CREATE TABLE "audit_view" (
	"audit_seq" bigint PRIMARY KEY NOT NULL,
	"recorded" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"role" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"outcome" text DEFAULT 'success' NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entry_hash" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_view_recorded_idx" ON "audit_view" USING btree ("recorded");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity");