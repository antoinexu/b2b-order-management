CREATE TYPE "public"."quote_delivery_status" AS ENUM('sending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "quote_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "quote_delivery_status" NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_name" text,
	"message" text,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"pdf" "bytea" NOT NULL,
	"quote_revision" integer NOT NULL,
	"sent_by_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"access_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_status_history" ALTER COLUMN "changed_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD COLUMN "changed_by_customer" text;--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_deliveries" ADD CONSTRAINT "quote_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_deliveries" ADD CONSTRAINT "quote_deliveries_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_deliveries" ADD CONSTRAINT "quote_deliveries_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quote_deliveries_idempotency_uq" ON "quote_deliveries" USING btree ("quote_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_deliveries_token_uq" ON "quote_deliveries" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "quote_deliveries_quote_idx" ON "quote_deliveries" USING btree ("quote_id");--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_status_history_actor" CHECK (("quote_status_history"."changed_by_id" IS NULL) <> ("quote_status_history"."changed_by_customer" IS NULL));