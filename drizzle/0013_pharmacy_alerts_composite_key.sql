ALTER TABLE "pharmacy_alerts" DROP CONSTRAINT "pharmacy_alerts_pkey";--> statement-breakpoint
ALTER TABLE "pharmacy_alerts" ADD CONSTRAINT "pharmacy_alerts_renewal_id_message_id_pk" PRIMARY KEY("renewal_id","message_id");
