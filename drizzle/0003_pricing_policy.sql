ALTER TABLE "organizations" ADD COLUMN "max_discount_bps" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;