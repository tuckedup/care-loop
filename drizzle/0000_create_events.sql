CREATE TABLE "events" (
	"global_position" bigserial PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"stream_version" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_stream_id_stream_version_unique" UNIQUE("stream_id","stream_version")
);
