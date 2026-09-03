import type { ReflectionTargetState, ReflectionTargetType } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

export const reflectionLedgerTargets = pgTable(
  "reflection_ledger_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    proposalAgentId: uuid("proposal_agent_id").notNull().references(() => agents.id),
    sourceRunId: uuid("source_run_id").notNull().references(() => heartbeatRuns.id),
    proposalKey: text("proposal_key").notNull(),
    targetKey: text("target_key").notNull(),
    targetType: text("target_type").$type<ReflectionTargetType>().notNull(),
    targetLabel: text("target_label").notNull(),
    proposalRevision: text("proposal_revision").notNull(),
    proposedDiff: text("proposed_diff"),
    evidenceMarkdown: text("evidence_markdown"),
    state: text("state").$type<ReflectionTargetState>().notNull().default("proposed"),
    confirmationInteractionId: uuid("confirmation_interaction_id")
      .references(() => issueThreadInteractions.id, { onDelete: "set null" }),
    applicationIssueId: uuid("application_issue_id").references(() => issues.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    validatedByAgentId: uuid("validated_by_agent_id").references(() => agents.id),
    validatedByRunId: uuid("validated_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    validatedByUserId: text("validated_by_user_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateCheck: check(
      "reflection_ledger_targets_state_check",
      sql`${table.state} in ('proposed', 'pending', 'accepted', 'applied', 'independently_validated', 'rejected', 'evidence_backed_no_change')`,
    ),
    issueIdx: index("reflection_ledger_targets_issue_idx").on(table.companyId, table.issueId, table.createdAt),
    issueStateIdx: index("reflection_ledger_targets_issue_state_idx").on(table.companyId, table.issueId, table.state),
    proposalTargetUq: uniqueIndex("reflection_ledger_targets_proposal_target_uq").on(
      table.companyId,
      table.issueId,
      table.proposalAgentId,
      table.proposalKey,
      table.targetKey,
      table.proposalRevision,
    ),
    confirmationInteractionUq: uniqueIndex("reflection_ledger_targets_confirmation_interaction_uq")
      .on(table.confirmationInteractionId)
      .where(sql`${table.confirmationInteractionId} is not null`),
    applicationIssueUq: uniqueIndex("reflection_ledger_targets_application_issue_uq")
      .on(table.applicationIssueId)
      .where(sql`${table.applicationIssueId} is not null`),
  }),
);

export const instructionMutationReceipts = pgTable(
  "instruction_mutation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    ledgerTargetId: uuid("ledger_target_id")
      .notNull()
      .references(() => reflectionLedgerTargets.id, { onDelete: "cascade" }),
    targetKey: text("target_key").notNull(),
    targetType: text("target_type").$type<ReflectionTargetType>().notNull(),
    targetLabel: text("target_label").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    acceptedInteractionId: uuid("accepted_interaction_id")
      .notNull()
      .references(() => issueThreadInteractions.id),
    applicationIssueId: uuid("application_issue_id").notNull(),
    actorAgentId: uuid("actor_agent_id").notNull().references(() => agents.id),
    actorRunId: uuid("actor_run_id").notNull().references(() => heartbeatRuns.id),
    instructionPath: text("instruction_path").notNull(),
    beforeContent: text("before_content").notNull(),
    appliedDiff: text("applied_diff").notNull(),
    postWriteContent: text("post_write_content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("instruction_mutation_receipts_issue_idx").on(table.companyId, table.issueId, table.createdAt),
    ledgerTargetUq: uniqueIndex("instruction_mutation_receipts_ledger_target_uq").on(table.ledgerTargetId),
    acceptedInteractionUq: uniqueIndex("instruction_mutation_receipts_accepted_interaction_uq")
      .on(table.acceptedInteractionId),
  }),
);
