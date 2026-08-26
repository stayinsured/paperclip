import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

export const issueTerminalOperations = pgTable(
  "issue_terminal_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    acceptanceRevision: text("acceptance_revision").notNull(),
    terminalStatus: text("terminal_status").$type<"done" | "cancelled">().notNull(),
    resultCommentId: uuid("result_comment_id").notNull().references(() => issueComments.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdempotencyUq: uniqueIndex("issue_terminal_operations_company_issue_idempotency_uq")
      .on(table.companyId, table.issueId, table.idempotencyKey),
    companyIssueCreatedAtIdx: index("issue_terminal_operations_company_issue_created_at_idx")
      .on(table.companyId, table.issueId, table.createdAt),
    runIdx: index("issue_terminal_operations_run_idx").on(table.runId),
  }),
);
