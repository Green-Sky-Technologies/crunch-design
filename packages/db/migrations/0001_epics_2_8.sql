CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."op_source" AS ENUM('canvas', 'inspector', 'slider', 'agent', 'restore', 'import', 'system');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('upload', 'screenshot', 'thumbnail', 'capture', 'export', 'figma');--> statement-breakpoint
CREATE TYPE "public"."doc_version_kind" AS ENUM('auto', 'named');--> statement-breakpoint
CREATE TYPE "public"."share_visibility" AS ENUM('workspace', 'public');--> statement-breakpoint
CREATE TYPE "public"."comment_thread_kind" AS ENUM('discussion', 'agent_request');--> statement-breakpoint
CREATE TYPE "public"."comment_thread_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('generate', 'redesign', 'alternatives', 'web_capture', 'ds_import_url', 'ds_import_figma', 'codegen', 'figma_export');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'provisioning', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."llm_task" AS ENUM('generation', 'interactive', 'utility', 'codegen', 'import', 'lint', 'test');--> statement-breakpoint
CREATE TYPE "public"."agent_message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."agent_message_status" AS ENUM('pending', 'streaming', 'complete', 'error', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."figma_direction" AS ENUM('push', 'import');--> statement-breakpoint
CREATE TABLE "design_system_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_system_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"notes" text,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"blob_url" text NOT NULL,
	"pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text,
	"meta" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_docs" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"doc" jsonb NOT NULL,
	"compacted_version" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_ops" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"txn_id" text NOT NULL,
	"ops" jsonb NOT NULL,
	"inverse" jsonb NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"source" "op_source" NOT NULL,
	"agent_message_id" uuid,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "doc_version_kind" NOT NULL,
	"name" text,
	"description" text,
	"doc_version" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"thumbnail_url" text,
	"agent_message_id" uuid,
	"restored_from_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"verb" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "comment_thread_kind" DEFAULT 'discussion' NOT NULL,
	"status" "comment_thread_status" DEFAULT 'open' NOT NULL,
	"anchor" jsonb NOT NULL,
	"fallback" jsonb,
	"agent_conversation_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_type" "actor_type" DEFAULT 'user' NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"mentions" text[] DEFAULT '{}' NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_locks" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"holder_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"visibility" "share_visibility" DEFAULT 'workspace' NOT NULL,
	"frame_ids" text[],
	"doc_version_id" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text,
	"scope" jsonb,
	"comment_thread_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "agent_message_role" NOT NULL,
	"content" jsonb NOT NULL,
	"status" "agent_message_status" DEFAULT 'complete' NOT NULL,
	"model" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"job_id" uuid,
	"snapshot_version_id" uuid,
	"txn_ids" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"design_system_id" uuid,
	"conversation_id" uuid,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"sandbox_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"timeout_seconds" integer DEFAULT 1800 NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text,
	"project_id" uuid,
	"job_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"task" "llm_task" NOT NULL,
	"provider" "model_provider" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"est_cost_micros" bigint DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"ok" boolean DEFAULT true NOT NULL,
	"error_type" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"model_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_models" text[],
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "figma_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_envelope" text NOT NULL,
	"hint" text NOT NULL,
	"figma_user_handle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "figma_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"direction" "figma_direction" NOT NULL,
	"figma_file_key" text NOT NULL,
	"figma_file_name" text,
	"figma_page_id" text,
	"node_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_report" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "figma_variable_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"design_system_id" uuid NOT NULL,
	"figma_file_key" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_pulled_at" timestamp with time zone,
	"last_pushed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "latest_version" integer;--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "design_systems" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "design_system_version_id" uuid;--> statement-breakpoint
ALTER TABLE "design_system_versions" ADD CONSTRAINT "design_system_versions_design_system_id_design_systems_id_fk" FOREIGN KEY ("design_system_id") REFERENCES "public"."design_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_versions" ADD CONSTRAINT "design_system_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_docs" ADD CONSTRAINT "design_docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_docs" ADD CONSTRAINT "design_docs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_ops" ADD CONSTRAINT "doc_ops_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_ops" ADD CONSTRAINT "doc_ops_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_threads" ADD CONSTRAINT "comment_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_threads" ADD CONSTRAINT "comment_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thread_id_comment_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."comment_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_locks" ADD CONSTRAINT "edit_locks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_locks" ADD CONSTRAINT "edit_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_tokens" ADD CONSTRAINT "job_tokens_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_settings" ADD CONSTRAINT "workspace_agent_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_credentials" ADD CONSTRAINT "figma_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_links" ADD CONSTRAINT "figma_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_links" ADD CONSTRAINT "figma_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_variable_links" ADD CONSTRAINT "figma_variable_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_variable_links" ADD CONSTRAINT "figma_variable_links_design_system_id_design_systems_id_fk" FOREIGN KEY ("design_system_id") REFERENCES "public"."design_systems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_tokens" ADD CONSTRAINT "plugin_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_system_versions_ds_version_idx" ON "design_system_versions" USING btree ("design_system_id","version");--> statement-breakpoint
CREATE INDEX "assets_project_idx" ON "assets" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_ops_project_version_idx" ON "doc_ops" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_ops_project_txn_idx" ON "doc_ops" USING btree ("project_id","txn_id");--> statement-breakpoint
CREATE INDEX "doc_versions_project_idx" ON "doc_versions" USING btree ("project_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "activity_project_idx" ON "activity" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_workspace_idx" ON "activity" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_threads_project_idx" ON "comment_threads" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "comments" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "presence_project_session_idx" ON "presence" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_idx" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_project_idx" ON "share_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_project_idx" ON "agent_conversations" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_conversation_seq_idx" ON "agent_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_job_seq_idx" ON "job_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "job_tokens_hash_idx" ON "job_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "jobs_project_idx" ON "jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "llm_calls_workspace_idx" ON "llm_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_user_idx" ON "llm_calls" USING btree ("workspace_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_job_idx" ON "llm_calls" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "figma_credentials_user_idx" ON "figma_credentials" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "figma_links_project_file_idx" ON "figma_links" USING btree ("project_id","figma_file_key","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "figma_variable_links_ds_file_idx" ON "figma_variable_links" USING btree ("design_system_id","figma_file_key");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_tokens_hash_idx" ON "plugin_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "plugin_tokens_workspace_idx" ON "plugin_tokens" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_design_system_version_id_design_system_versions_id_fk" FOREIGN KEY ("design_system_version_id") REFERENCES "public"."design_system_versions"("id") ON DELETE set null ON UPDATE no action;