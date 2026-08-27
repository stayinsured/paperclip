import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueComments,
  issues,
  issueTerminalOperations,
} from "@paperclipai/db";
import type { SourceTrustMetadata, TerminalIssueCompletion } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { issueService } from "./issues.js";

function terminalRequestHash(input: TerminalIssueCompletion) {
  return createHash("sha256")
    .update(JSON.stringify({
      acceptanceRevision: input.acceptanceRevision,
      result: input.result,
      status: input.status,
    }))
    .digest("hex");
}

export function issueTerminalCompletionService(db: Db) {
  const issuesSvc = issueService(db);

  return {
    complete: async (input: {
      companyId: string;
      issueId: string;
      runId: string;
      agentId: string;
      operation: TerminalIssueCompletion;
      authorizationReason?: string | null;
      sourceTrust?: SourceTrustMetadata | null;
      onBehalfOfUserId?: string | null;
    }) => {
      const requestHash = terminalRequestHash(input.operation);
      return db.transaction(async (tx) => {
        const lockKey = `issue-terminal:${input.companyId}:${input.issueId}:${input.operation.idempotencyKey}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

        const existingOperation = await tx
          .select()
          .from(issueTerminalOperations)
          .where(and(
            eq(issueTerminalOperations.companyId, input.companyId),
            eq(issueTerminalOperations.issueId, input.issueId),
            eq(issueTerminalOperations.idempotencyKey, input.operation.idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);

        if (existingOperation) {
          if (existingOperation.requestHash !== requestHash) {
            throw conflict("Terminal completion idempotency key was reused with a different request", {
              code: "terminal_idempotency_conflict",
              idempotencyKey: input.operation.idempotencyKey,
            });
          }
          const [issue, comment] = await Promise.all([
            tx.select().from(issues).where(and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            )).then((rows) => rows[0] ?? null),
            tx.select().from(issueComments).where(eq(
              issueComments.id,
              existingOperation.resultCommentId,
            )).then((rows) => rows[0] ?? null),
          ]);
          if (!issue || !comment) {
            throw conflict("Terminal completion receipt is incomplete", {
              code: "terminal_receipt_incomplete",
              operationId: existingOperation.id,
            });
          }
          return { issue, comment, operation: existingOperation, replayed: true as const };
        }

        const currentIssue = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, input.issueId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!currentIssue) {
          throw notFound("Issue not found", { code: "task_not_found" });
        }
        if (currentIssue.companyId !== input.companyId) {
          throw forbidden("Issue belongs to another company", { code: "wrong_company" });
        }
        if (currentIssue.status === "done" || currentIssue.status === "cancelled") {
          throw conflict("Issue already has a terminal disposition", {
            code: "issue_already_terminal",
            status: currentIssue.status,
          });
        }
        if (currentIssue.assigneeAgentId !== input.agentId) {
          throw conflict("Only the assigned agent can terminally complete this issue", {
            code: "terminal_run_context_mismatch",
          });
        }
        const ownsRun = currentIssue.checkoutRunId === input.runId || currentIssue.executionRunId === input.runId;
        if (!ownsRun) {
          throw conflict("Terminal completion run does not own the issue execution lock", {
            code: "terminal_run_context_mismatch",
          });
        }

        const comment = await issuesSvc.addComment(
          input.issueId,
          input.operation.result,
          {
            agentId: input.agentId,
            runId: input.runId,
            onBehalfOfUserId: input.onBehalfOfUserId,
          },
          {
            authorizationReason: input.authorizationReason,
            sourceTrust: input.sourceTrust,
          },
          tx,
        );
        const issue = await issuesSvc.update(input.issueId, {
          status: input.operation.status,
          actorAgentId: input.agentId,
        }, tx);
        if (!issue) throw notFound("Issue not found", { code: "task_not_found" });

        const operation = await tx
          .insert(issueTerminalOperations)
          .values({
            companyId: input.companyId,
            issueId: input.issueId,
            runId: input.runId,
            idempotencyKey: input.operation.idempotencyKey,
            requestHash,
            acceptanceRevision: input.operation.acceptanceRevision,
            terminalStatus: input.operation.status,
            resultCommentId: comment.id,
          })
          .returning()
          .then((rows) => rows[0]!);

        return { issue, comment, operation, replayed: false as const };
      });
    },
  };
}
