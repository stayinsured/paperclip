CREATE TABLE "plugin_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"principal_agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid,
	"company_skill_id" uuid NOT NULL,
	"company_skill_version_id" uuid NOT NULL,
	"skill_revision_number" integer NOT NULL,
	"assessment_id" text NOT NULL,
	"coordinator_attempt_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"skill_content_digest" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"capability_token_digest" text,
	"allowed_tool" text NOT NULL,
	"runtime_expires_at" timestamp with time zone NOT NULL,
	"callback_expires_at" timestamp with time zone NOT NULL,
	"billing_code" text NOT NULL,
	"sanitized_envelope" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"terminal_reason" text,
	"request_digest" text,
	"result_digest" text,
	"callback_request_json" jsonb,
	"result_json" jsonb,
	"replay_state" text DEFAULT 'none' NOT NULL,
	"provider" text,
	"biller" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"billing_type" text,
	"billing_status" text,
	"cost_cents" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_execution_attempts" ADD CONSTRAINT "plugin_execution_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_execution_attempts" ADD CONSTRAINT "plugin_execution_attempts_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_execution_attempts" ADD CONSTRAINT "plugin_execution_attempts_principal_agent_id_agents_id_fk" FOREIGN KEY ("principal_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_execution_attempts" ADD CONSTRAINT "plugin_execution_attempts_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_execution_attempts" ADD CONSTRAINT "plugin_execution_attempts_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_execution_attempts" ADD CONSTRAINT "plugin_execution_attempts_company_skill_version_id_company_skill_versions_id_fk" FOREIGN KEY ("company_skill_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_execution_attempts_company_status_idx" ON "plugin_execution_attempts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "plugin_execution_attempts_plugin_idx" ON "plugin_execution_attempts" USING btree ("plugin_id","created_at");--> statement-breakpoint
CREATE INDEX "plugin_execution_attempts_principal_idx" ON "plugin_execution_attempts" USING btree ("principal_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "plugin_execution_attempts_skill_version_idx" ON "plugin_execution_attempts" USING btree ("company_skill_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_execution_attempts_heartbeat_run_uq" ON "plugin_execution_attempts" USING btree ("heartbeat_run_id") WHERE "plugin_execution_attempts"."heartbeat_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_execution_attempts_coordinator_attempt_uq" ON "plugin_execution_attempts" USING btree ("company_id","plugin_id","coordinator_attempt_id");