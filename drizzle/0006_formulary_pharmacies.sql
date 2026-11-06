CREATE TABLE "formulary" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rxcui" text,
	"allowlisted" boolean NOT NULL,
	"controlled_schedule" text,
	"aliases" jsonb NOT NULL,
	"form_tokens" jsonb NOT NULL,
	CONSTRAINT "formulary_schedule_check" CHECK ("formulary"."controlled_schedule" is null or "formulary"."controlled_schedule" in ('II', 'III', 'IV', 'V')),
	CONSTRAINT "formulary_controlled_not_allowlisted" CHECK (not ("formulary"."allowlisted" and "formulary"."controlled_schedule" is not null))
);
--> statement-breakpoint
CREATE TABLE "pharmacies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"phone" text NOT NULL,
	CONSTRAINT "pharmacies_id_seven_digits" CHECK ("pharmacies"."id" ~ '^[0-9]{7}$')
);
--> statement-breakpoint
CREATE INDEX "formulary_rxcui_idx" ON "formulary" USING btree ("rxcui");