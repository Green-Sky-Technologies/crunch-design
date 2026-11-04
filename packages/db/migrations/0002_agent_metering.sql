ALTER TABLE "jobs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cache_write_1h_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "meta" jsonb;