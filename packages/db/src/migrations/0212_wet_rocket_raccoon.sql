CREATE TABLE IF NOT EXISTS "issue_terminal_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"acceptance_revision" text NOT NULL,
	"terminal_status" text NOT NULL,
	"result_comment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_terminal_operations" ADD CONSTRAINT "issue_terminal_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_terminal_operations" ADD CONSTRAINT "issue_terminal_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_terminal_operations" ADD CONSTRAINT "issue_terminal_operations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_terminal_operations" ADD CONSTRAINT "issue_terminal_operations_result_comment_id_issue_comments_id_fk" FOREIGN KEY ("result_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_terminal_operations_company_issue_idempotency_uq" ON "issue_terminal_operations" USING btree ("company_id","issue_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_terminal_operations_company_issue_created_at_idx" ON "issue_terminal_operations" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_terminal_operations_run_idx" ON "issue_terminal_operations" USING btree ("run_id");