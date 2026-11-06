CREATE TABLE "projection_anomalies" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"projection" text NOT NULL,
	"event_position" bigint NOT NULL,
	"stream_id" text NOT NULL,
	"event_type" text NOT NULL,
	"code" text NOT NULL,
	"detail" text NOT NULL,
	CONSTRAINT "projection_anomalies_unique" UNIQUE("projection","event_position","code")
);
--> statement-breakpoint
-- phq9_trend is a rebuildable projection: re-key it by (renewal_id, event position).
ALTER TABLE "phq9_trend" DROP CONSTRAINT "phq9_trend_pkey";--> statement-breakpoint
ALTER TABLE "phq9_trend" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "phq9_trend" ADD CONSTRAINT "phq9_trend_renewal_id_position_pk" PRIMARY KEY("renewal_id","position");--> statement-breakpoint
ALTER TABLE "phq9_trend" ADD COLUMN "orphan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "renewal_queue" ADD COLUMN "request_position" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "renewal_queue" ADD COLUMN "anomalies" jsonb DEFAULT '[]'::jsonb NOT NULL;