CREATE TABLE "projection_checkpoints" (
	"name" text PRIMARY KEY NOT NULL,
	"last_position" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
