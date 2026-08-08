import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { companySkills, companySkillVersions } from "./company_skills.js";

/** Durable authority, replay, terminal-state, and billing record for one restricted plugin-model run. */
export const pluginExecutionAttempts = pgTable(
  "plugin_execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "restrict" }),
    pluginKey: text("plugin_key").notNull(),
    principalAgentId: uuid("principal_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    companySkillId: uuid("company_skill_id").notNull().references(() => companySkills.id, { onDelete: "restrict" }),
    companySkillVersionId: uuid("company_skill_version_id").notNull().references(() => companySkillVersions.id, { onDelete: "restrict" }),
    skillRevisionNumber: integer("skill_revision_number").notNull(),
    assessmentId: text("assessment_id").notNull(),
    coordinatorAttemptId: text("coordinator_attempt_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    policyId: text("policy_id").notNull(),
    policyVersion: text("policy_version").notNull(),
    skillContentDigest: text("skill_content_digest").notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    capabilityTokenDigest: text("capability_token_digest"),
    allowedTool: text("allowed_tool").notNull(),
    runtimeExpiresAt: timestamp("runtime_expires_at", { withTimezone: true }).notNull(),
    callbackExpiresAt: timestamp("callback_expires_at", { withTimezone: true }).notNull(),
    billingCode: text("billing_code").notNull(),
    sanitizedEnvelope: jsonb("sanitized_envelope").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("queued"),
    terminalReason: text("terminal_reason"),
    requestDigest: text("request_digest"),
    resultDigest: text("result_digest"),
    callbackRequestJson: jsonb("callback_request_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<unknown>(),
    replayState: text("replay_state").notNull().default("none"),
    provider: text("provider"),
    biller: text("biller"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    durationMs: integer("duration_ms"),
    billingType: text("billing_type"),
    billingStatus: text("billing_status"),
    costCents: integer("cost_cents"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("plugin_execution_attempts_company_status_idx").on(table.companyId, table.status),
    pluginIdx: index("plugin_execution_attempts_plugin_idx").on(table.pluginId, table.createdAt),
    principalIdx: index("plugin_execution_attempts_principal_idx").on(table.principalAgentId, table.createdAt),
    skillVersionIdx: index("plugin_execution_attempts_skill_version_idx").on(table.companySkillVersionId),
    heartbeatRunUq: uniqueIndex("plugin_execution_attempts_heartbeat_run_uq")
      .on(table.heartbeatRunId)
      .where(sql`${table.heartbeatRunId} is not null`),
    coordinatorAttemptUq: uniqueIndex("plugin_execution_attempts_coordinator_attempt_uq").on(
      table.companyId,
      table.pluginId,
      table.coordinatorAttemptId,
    ),
  }),
);
