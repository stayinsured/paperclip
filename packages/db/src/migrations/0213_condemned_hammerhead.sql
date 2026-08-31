CREATE TABLE "instruction_mutation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ledger_target_id" uuid NOT NULL,
	"target_key" text NOT NULL,
	"target_type" text NOT NULL,
	"target_label" text NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"accepted_interaction_id" uuid NOT NULL,
	"application_issue_id" uuid NOT NULL,
	"actor_agent_id" uuid NOT NULL,
	"actor_run_id" uuid NOT NULL,
	"instruction_path" text NOT NULL,
	"before_content" text NOT NULL,
	"applied_diff" text NOT NULL,
	"post_write_content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reflection_ledger_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"proposal_agent_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"proposal_key" text NOT NULL,
	"target_key" text NOT NULL,
	"target_type" text NOT NULL,
	"target_label" text NOT NULL,
	"proposal_revision" text NOT NULL,
	"proposed_diff" text,
	"evidence_markdown" text,
	"state" text DEFAULT 'proposed' NOT NULL,
	"confirmation_interaction_id" uuid,
	"application_issue_id" uuid,
	"accepted_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"validated_at" timestamp with time zone,
	"validated_by_agent_id" uuid,
	"validated_by_run_id" uuid,
	"validated_by_user_id" text,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflection_ledger_targets_state_check" CHECK ("reflection_ledger_targets"."state" in ('proposed', 'pending', 'accepted', 'applied', 'independently_validated', 'rejected', 'evidence_backed_no_change'))
);
--> statement-breakpoint
ALTER TABLE "instruction_mutation_receipts" ADD CONSTRAINT "instruction_mutation_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_mutation_receipts" ADD CONSTRAINT "instruction_mutation_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_mutation_receipts" ADD CONSTRAINT "instruction_mutation_receipts_ledger_target_id_reflection_ledger_targets_id_fk" FOREIGN KEY ("ledger_target_id") REFERENCES "public"."reflection_ledger_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_mutation_receipts" ADD CONSTRAINT "instruction_mutation_receipts_accepted_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("accepted_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_mutation_receipts" ADD CONSTRAINT "instruction_mutation_receipts_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_mutation_receipts" ADD CONSTRAINT "instruction_mutation_receipts_actor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("actor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_proposal_agent_id_agents_id_fk" FOREIGN KEY ("proposal_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_confirmation_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("confirmation_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_application_issue_id_issues_id_fk" FOREIGN KEY ("application_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_validated_by_agent_id_agents_id_fk" FOREIGN KEY ("validated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_ledger_targets" ADD CONSTRAINT "reflection_ledger_targets_validated_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("validated_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instruction_mutation_receipts_issue_idx" ON "instruction_mutation_receipts" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_mutation_receipts_ledger_target_uq" ON "instruction_mutation_receipts" USING btree ("ledger_target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_mutation_receipts_accepted_interaction_uq" ON "instruction_mutation_receipts" USING btree ("accepted_interaction_id");--> statement-breakpoint
CREATE INDEX "reflection_ledger_targets_issue_idx" ON "reflection_ledger_targets" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "reflection_ledger_targets_issue_state_idx" ON "reflection_ledger_targets" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "reflection_ledger_targets_proposal_target_uq" ON "reflection_ledger_targets" USING btree ("company_id","issue_id","proposal_agent_id","proposal_key","target_key","proposal_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "reflection_ledger_targets_confirmation_interaction_uq" ON "reflection_ledger_targets" USING btree ("confirmation_interaction_id") WHERE "reflection_ledger_targets"."confirmation_interaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reflection_ledger_targets_application_issue_uq" ON "reflection_ledger_targets" USING btree ("application_issue_id") WHERE "reflection_ledger_targets"."application_issue_id" is not null;