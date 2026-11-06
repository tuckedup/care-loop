CREATE TABLE "audit_chain_head" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_chain_head_single_row" CHECK ("audit_chain_head"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"role" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_log_hash_unique" UNIQUE("hash")
);
