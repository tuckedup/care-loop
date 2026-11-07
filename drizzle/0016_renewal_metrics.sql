CREATE TABLE "renewal_metrics" (
	"renewal_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision" text,
	"decided_by" text,
	"autonomy_mode" text,
	"escalated" boolean DEFAULT false NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_started" boolean DEFAULT false NOT NULL,
	"auto_approved_at" timestamp with time zone,
	"sampled" boolean DEFAULT false NOT NULL,
	"sample_reason" text,
	"retro_reviewer_id" text,
	"retro_concur" boolean,
	"retro_reviewed_at" timestamp with time zone,
	"last_position" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "renewal_metrics_sampled_idx" ON "renewal_metrics" USING btree ("sampled","auto_approved_at");--> statement-breakpoint
CREATE INDEX "renewal_metrics_decided_idx" ON "renewal_metrics" USING btree ("decided_at");