CREATE TABLE "quote_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"from_status" "quote_status",
	"to_status" "quote_status" NOT NULL,
	"changed_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_status_history_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_status_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_status_history_quote_idx" ON "quote_status_history" USING btree ("quote_id");--> statement-breakpoint
-- Backfill: existing quotes get their creation entry. Earlier transitions were never recorded, so they cannot be reconstructed.
INSERT INTO "quote_status_history" ("quote_id", "from_status", "to_status", "changed_by_id", "created_at")
SELECT "id", NULL, 'draft', "created_by_id", "created_at" FROM "quotes";