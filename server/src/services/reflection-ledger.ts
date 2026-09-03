import { isDeepStrictEqual } from "node:util";
import {
  agents,
  heartbeatRuns,
  instructionMutationReceipts,
  issueThreadInteractions,
  reflectionLedgerTargets,
  type Db,
} from "@paperclipai/db";
import type {
  InstructionMutationReceipt,
  IssueReflectionEvidence,
  ReflectionLedgerTarget,
  RegisterReflectionProposal,
  RequestConfirmationResult,
} from "@paperclipai/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { issueService } from "./issues.js";

type ReflectionIssue = {
  id: string;
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
};

type ReflectionActor = {
  agentId: string;
  runId: string;
};

type ConfirmationTarget = {
  type: string;
  key: string;
  revisionId?: string | null;
};

export type InstructionConsentGrant = {
  interactionId: string;
  issueId: string;
  ledgerTargetId: string;
  applicationIssueId: string;
  targetKey: string;
  targetType: string;
  targetLabel: string;
  proposedDiff: string;
  consumed: boolean;
  existingReceipt: InstructionMutationReceipt | null;
};

function serializeTarget(row: typeof reflectionLedgerTargets.$inferSelect): ReflectionLedgerTarget {
  return row as ReflectionLedgerTarget;
}

function serializeReceipt(row: typeof instructionMutationReceipts.$inferSelect): InstructionMutationReceipt {
  return row as InstructionMutationReceipt;
}

function receiptContentMatches(
  receipt: InstructionMutationReceipt,
  input: { targetAgentId: string; instructionPath: string; postWriteContent: string },
) {
  return receipt.targetAgentId === input.targetAgentId
    && receipt.instructionPath === input.instructionPath
    && receipt.postWriteContent === input.postWriteContent;
}

export function buildInstructionContentDiff(path: string, before: string, after: string) {
  if (before === after) return "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}

export function reflectionLedgerService(db: Db) {
  async function assertReflectionCoach(companyId: string, issueId: string, actor: ReflectionActor) {
    const [agent, run] = await Promise.all([
      db.select({ companyId: agents.companyId, metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, actor.agentId))
        .then((rows) => rows[0] ?? null),
      db.select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, actor.runId))
        .then((rows) => rows[0] ?? null),
    ]);
    if (!agent || agent.companyId !== companyId || readBuiltInAgentMarker(agent.metadata)?.key !== "reflection-coach") {
      throw forbidden("Only the built-in Reflection Coach can register reflection proposals");
    }
    if (!run || run.companyId !== companyId || run.agentId !== actor.agentId) {
      throw forbidden("Reflection proposal run must belong to the acting Reflection Coach");
    }
    const runContext = run.contextSnapshot && typeof run.contextSnapshot === "object"
      ? run.contextSnapshot as Record<string, unknown>
      : {};
    const runIssueId = typeof runContext.issueId === "string" ? runContext.issueId : runContext.taskId;
    if (runIssueId !== issueId) {
      throw forbidden("Reflection proposal run must be scoped to the reflection issue");
    }
  }

  async function listForIssue(issue: ReflectionIssue): Promise<IssueReflectionEvidence> {
    const [targets, receipts] = await Promise.all([
      db.select().from(reflectionLedgerTargets)
        .where(and(
          eq(reflectionLedgerTargets.companyId, issue.companyId),
          eq(reflectionLedgerTargets.issueId, issue.id),
        ))
        .orderBy(asc(reflectionLedgerTargets.createdAt), asc(reflectionLedgerTargets.id)),
      db.select().from(instructionMutationReceipts)
        .where(and(
          eq(instructionMutationReceipts.companyId, issue.companyId),
          eq(instructionMutationReceipts.issueId, issue.id),
        ))
        .orderBy(asc(instructionMutationReceipts.createdAt), asc(instructionMutationReceipts.id)),
    ]);
    return {
      targets: targets.map(serializeTarget),
      receipts: receipts.map(serializeReceipt),
    };
  }

  async function getReceiptForIssue(issue: ReflectionIssue, receiptId: string) {
    const row = await db.select().from(instructionMutationReceipts)
      .where(and(
        eq(instructionMutationReceipts.id, receiptId),
        eq(instructionMutationReceipts.companyId, issue.companyId),
        eq(instructionMutationReceipts.issueId, issue.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Instruction mutation receipt not found");
    return serializeReceipt(row);
  }

  async function registerProposal(
    issue: ReflectionIssue,
    input: RegisterReflectionProposal,
    actor: ReflectionActor,
  ) {
    await assertReflectionCoach(issue.companyId, issue.id, actor);
    return db.transaction(async (tx) => {
      const lockKey = `reflection-proposal:${issue.companyId}:${issue.id}:${actor.agentId}:${input.proposalKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      for (const target of input.targets) {
        await tx.insert(reflectionLedgerTargets).values({
          companyId: issue.companyId,
          issueId: issue.id,
          proposalAgentId: actor.agentId,
          sourceRunId: actor.runId,
          proposalKey: input.proposalKey,
          targetKey: target.targetKey,
          targetType: target.targetType,
          targetLabel: target.targetLabel,
          proposalRevision: target.proposalRevision,
          proposedDiff: target.proposedDiff ?? null,
          evidenceMarkdown: target.evidenceMarkdown ?? null,
          state: target.state,
        }).onConflictDoNothing();
      }

      const rows = await tx.select().from(reflectionLedgerTargets)
        .where(and(
          eq(reflectionLedgerTargets.companyId, issue.companyId),
          eq(reflectionLedgerTargets.issueId, issue.id),
          eq(reflectionLedgerTargets.proposalAgentId, actor.agentId),
          eq(reflectionLedgerTargets.proposalKey, input.proposalKey),
        ))
        .orderBy(asc(reflectionLedgerTargets.createdAt), asc(reflectionLedgerTargets.id));

      const requested = input.targets.map((target) => ({
        targetKey: target.targetKey,
        targetType: target.targetType,
        targetLabel: target.targetLabel,
        proposalRevision: target.proposalRevision,
        proposedDiff: target.proposedDiff ?? null,
        evidenceMarkdown: target.evidenceMarkdown ?? null,
        state: target.state,
      }));
      const persisted = rows.map((row) => ({
        targetKey: row.targetKey,
        targetType: row.targetType,
        targetLabel: row.targetLabel,
        proposalRevision: row.proposalRevision,
        proposedDiff: row.proposedDiff,
        evidenceMarkdown: row.evidenceMarkdown,
        state: (row.state === "evidence_backed_no_change" ? row.state : "proposed") as "proposed" | "evidence_backed_no_change",
      }));
      const normalize = (values: typeof requested) => [...values].sort((left, right) =>
        `${left.targetKey}:${left.proposalRevision}`.localeCompare(`${right.targetKey}:${right.proposalRevision}`));
      if (!isDeepStrictEqual(normalize(persisted), normalize(requested))) {
        throw conflict("Reflection proposal key already exists with different targets", {
          proposalKey: input.proposalKey,
        });
      }
      const rowsByIdentity = new Map(rows.map((row) => [
        `${row.targetKey}\u0000${row.proposalRevision}`,
        row,
      ]));
      return input.targets.map((target) => serializeTarget(
        rowsByIdentity.get(`${target.targetKey}\u0000${target.proposalRevision}`)!,
      ));
    });
  }

  async function linkConfirmation(
    tx: Db,
    input: {
      issue: ReflectionIssue;
      interactionId: string;
      actorAgentId: string;
      target: ConfirmationTarget | null | undefined;
      detailsMarkdown: string | null | undefined;
    },
  ) {
    if (input.target?.type !== "custom" || !input.target.revisionId) return null;
    const row = await tx.select().from(reflectionLedgerTargets)
      .where(and(
        eq(reflectionLedgerTargets.companyId, input.issue.companyId),
        eq(reflectionLedgerTargets.issueId, input.issue.id),
        eq(reflectionLedgerTargets.proposalAgentId, input.actorAgentId),
        eq(reflectionLedgerTargets.targetKey, input.target.key),
        eq(reflectionLedgerTargets.proposalRevision, input.target.revisionId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    if (row.state === "evidence_backed_no_change" || row.state === "rejected") {
      throw conflict("Terminal reflection targets cannot open a confirmation");
    }
    if (row.proposedDiff !== (input.detailsMarkdown ?? null)) {
      throw conflict("Reflection confirmation diff must exactly match the registered target diff");
    }
    if (row.confirmationInteractionId && row.confirmationInteractionId !== input.interactionId) {
      throw conflict("Reflection target already has a confirmation interaction", {
        interactionId: row.confirmationInteractionId,
      });
    }
    const now = new Date();
    const updated = await tx.update(reflectionLedgerTargets)
      .set({
        state: row.state === "proposed" ? "pending" : row.state,
        confirmationInteractionId: input.interactionId,
        updatedAt: now,
      })
      .where(eq(reflectionLedgerTargets.id, row.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    return updated ? serializeTarget(updated) : null;
  }

  async function markDecision(
    tx: Db,
    interactionId: string,
    decision: "accepted" | "rejected",
  ) {
    const row = await tx.select().from(reflectionLedgerTargets)
      .where(eq(reflectionLedgerTargets.confirmationInteractionId, interactionId))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    if (row.state === decision) return serializeTarget(row);
    if (row.state !== "pending") {
      throw conflict(`Reflection target cannot transition from ${row.state} to ${decision}`);
    }
    const now = new Date();
    const updated = await tx.update(reflectionLedgerTargets)
      .set({
        state: decision,
        acceptedAt: decision === "accepted" ? now : row.acceptedAt,
        rejectedAt: decision === "rejected" ? now : row.rejectedAt,
        updatedAt: now,
      })
      .where(and(
        eq(reflectionLedgerTargets.id, row.id),
        eq(reflectionLedgerTargets.state, "pending"),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Reflection target was decided concurrently");
    return serializeTarget(updated);
  }

  async function ensureApplicationPath(issue: ReflectionIssue, interactionId: string) {
    const target = await db.select().from(reflectionLedgerTargets)
      .where(and(
        eq(reflectionLedgerTargets.companyId, issue.companyId),
        eq(reflectionLedgerTargets.issueId, issue.id),
        eq(reflectionLedgerTargets.confirmationInteractionId, interactionId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!target) return null;
    if (!["accepted", "applied", "independently_validated"].includes(target.state)) {
      throw conflict("Only accepted reflection targets can create an application path");
    }
    const applicationIssue = await issueService(db).create(issue.companyId, {
      title: `Apply reflection target: ${target.targetLabel}`,
      description: [
        `Apply the accepted reflection target \`${target.targetKey}\` from the parent issue.`,
        "Use the accepted interaction and the instruction mutation endpoint. The server will persist the receipt after readback.",
      ].join("\n\n"),
      status: "todo",
      priority: "medium",
      parentId: issue.id,
      projectId: issue.projectId ?? null,
      goalId: issue.goalId ?? null,
      assigneeAgentId: target.proposalAgentId,
      createdByAgentId: target.proposalAgentId,
      originKind: "reflection_application",
      originId: interactionId,
      originFingerprint: target.id,
      idempotencyKey: `reflection-application:${interactionId}`,
      allowDuplicate: true,
    });
    await db.update(reflectionLedgerTargets)
      .set({ applicationIssueId: applicationIssue.id, updatedAt: new Date() })
      .where(and(
        eq(reflectionLedgerTargets.id, target.id),
        sql`${reflectionLedgerTargets.applicationIssueId} is null`,
      ));
    return applicationIssue;
  }

  async function findInstructionConsent(input: {
    companyId: string;
    actorAgentId: string;
    actorRunId: string;
    targetKey: string;
  }): Promise<InstructionConsentGrant | null> {
    const actorRun = await db.select({
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, input.actorRunId)).then((rows) => rows[0] ?? null);
    if (!actorRun || actorRun.companyId !== input.companyId || actorRun.agentId !== input.actorAgentId) return null;
    const runContext = actorRun.contextSnapshot && typeof actorRun.contextSnapshot === "object"
      ? actorRun.contextSnapshot as Record<string, unknown>
      : {};
    const runIssueId = typeof runContext.issueId === "string" ? runContext.issueId : runContext.taskId;
    const rows = await db.select({
      target: reflectionLedgerTargets,
      interaction: issueThreadInteractions,
      receipt: instructionMutationReceipts,
    })
      .from(reflectionLedgerTargets)
      .innerJoin(
        issueThreadInteractions,
        eq(reflectionLedgerTargets.confirmationInteractionId, issueThreadInteractions.id),
      )
      .leftJoin(
        instructionMutationReceipts,
        eq(instructionMutationReceipts.ledgerTargetId, reflectionLedgerTargets.id),
      )
      .where(and(
        eq(reflectionLedgerTargets.companyId, input.companyId),
        eq(reflectionLedgerTargets.proposalAgentId, input.actorAgentId),
        eq(reflectionLedgerTargets.targetKey, input.targetKey),
        eq(issueThreadInteractions.status, "accepted"),
      ))
      .orderBy(sql`${reflectionLedgerTargets.acceptedAt} desc nulls last`)
      .limit(10);
    for (const row of rows) {
      if (!row.target.applicationIssueId) continue;
      if (runIssueId !== row.target.applicationIssueId) continue;
      if (row.target.sourceRunId === input.actorRunId) continue;
      if (!row.target.proposedDiff) continue;
      const result = row.interaction.result as { consumedByRunId?: unknown; consumedAt?: unknown } | null;
      const consumed = typeof result?.consumedByRunId === "string" || typeof result?.consumedAt === "string";
      if (consumed && !row.receipt) continue;
      return {
        interactionId: row.interaction.id,
        issueId: row.target.issueId,
        ledgerTargetId: row.target.id,
        applicationIssueId: row.target.applicationIssueId,
        targetKey: row.target.targetKey,
        targetType: row.target.targetType,
        targetLabel: row.target.targetLabel,
        proposedDiff: row.target.proposedDiff,
        consumed,
        existingReceipt: row.receipt ? serializeReceipt(row.receipt) : null,
      };
    }
    return null;
  }

  async function consumeInstructionConsent(input: {
    grant: InstructionConsentGrant;
    targetAgentId: string;
    instructionPath: string;
    beforeContent: string;
    postWriteContent: string;
    actorAgentId: string;
    actorRunId: string;
  }): Promise<{ receipt: InstructionMutationReceipt; replay: boolean }> {
    return db.transaction(async (tx) => {
      const existingReceipt = await tx.select().from(instructionMutationReceipts)
        .where(eq(instructionMutationReceipts.ledgerTargetId, input.grant.ledgerTargetId))
        .then((rows) => rows[0] ?? null);
      if (existingReceipt) {
        const receipt = serializeReceipt(existingReceipt);
        if (!receiptContentMatches(receipt, input)) {
          throw forbidden("Accepted reflection consent was already consumed by a different instruction mutation");
        }
        return { receipt, replay: true };
      }

      const interaction = await tx.select().from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, input.grant.interactionId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const target = await tx.select().from(reflectionLedgerTargets)
        .where(eq(reflectionLedgerTargets.id, input.grant.ledgerTargetId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!interaction || !target || target.state !== "accepted" || !target.applicationIssueId) {
        throw forbidden("Accepted reflection consent is not available for this instruction mutation");
      }
      const result = interaction.result as Record<string, unknown> | null;
      if (interaction.status !== "accepted" || result?.outcome !== "accepted") {
        throw forbidden("Accepted reflection consent is not available for this instruction mutation");
      }
      if (typeof result.consumedByRunId === "string" || typeof result.consumedAt === "string") {
        throw forbidden("Accepted reflection consent has already been consumed");
      }
      const acceptedResult = result as unknown as RequestConfirmationResult;
      const appliedDiff = buildInstructionContentDiff(
        input.instructionPath,
        input.beforeContent,
        input.postWriteContent,
      );
      if (!target.proposedDiff || target.proposedDiff !== appliedDiff) {
        throw forbidden("Instruction mutation must exactly match the accepted reflection diff");
      }

      const now = new Date();
      const [receipt] = await tx.insert(instructionMutationReceipts).values({
        companyId: target.companyId,
        issueId: target.issueId,
        ledgerTargetId: target.id,
        targetKey: target.targetKey,
        targetType: target.targetType,
        targetLabel: target.targetLabel,
        targetAgentId: input.targetAgentId,
        acceptedInteractionId: interaction.id,
        applicationIssueId: target.applicationIssueId,
        actorAgentId: input.actorAgentId,
        actorRunId: input.actorRunId,
        instructionPath: input.instructionPath,
        beforeContent: input.beforeContent,
        appliedDiff,
        postWriteContent: input.postWriteContent,
        createdAt: now,
      }).returning();
      await tx.update(issueThreadInteractions)
        .set({
          result: {
            ...acceptedResult,
            consumedAt: now.toISOString(),
            consumedByRunId: input.actorRunId,
          },
          updatedAt: now,
        })
        .where(eq(issueThreadInteractions.id, interaction.id));
      await tx.update(reflectionLedgerTargets)
        .set({ state: "applied", appliedAt: now, updatedAt: now })
        .where(eq(reflectionLedgerTargets.id, target.id));
      return { receipt: serializeReceipt(receipt), replay: false };
    });
  }

  async function validateTarget(
    issue: ReflectionIssue,
    targetId: string,
    evidenceMarkdown: string,
    actor: { agentId?: string | null; runId?: string | null; userId?: string | null },
  ): Promise<{ target: ReflectionLedgerTarget; changed: boolean }> {
    return db.transaction(async (tx) => {
      const target = await tx.select().from(reflectionLedgerTargets)
        .where(and(
          eq(reflectionLedgerTargets.id, targetId),
          eq(reflectionLedgerTargets.companyId, issue.companyId),
          eq(reflectionLedgerTargets.issueId, issue.id),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Reflection target not found");
      if (actor.agentId && actor.agentId === target.proposalAgentId) {
        throw forbidden("The Reflection Coach that proposed a target cannot independently validate it");
      }
      if (target.state === "independently_validated") {
        if (target.evidenceMarkdown !== evidenceMarkdown) {
          throw conflict("Reflection target already has different validation evidence");
        }
        return { target: serializeTarget(target), changed: false };
      }
      if (target.state !== "applied") {
        throw unprocessable("Only applied reflection targets can be independently validated");
      }
      const now = new Date();
      const updated = await tx.update(reflectionLedgerTargets)
        .set({
          state: "independently_validated",
          evidenceMarkdown,
          validatedAt: now,
          validatedByAgentId: actor.agentId ?? null,
          validatedByRunId: actor.runId ?? null,
          validatedByUserId: actor.userId ?? null,
          updatedAt: now,
        })
        .where(and(
          eq(reflectionLedgerTargets.id, target.id),
          eq(reflectionLedgerTargets.state, "applied"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw conflict("Reflection target was validated concurrently");
      return { target: serializeTarget(updated), changed: true };
    });
  }

  return {
    registerProposal,
    listForIssue,
    getReceiptForIssue,
    linkConfirmation,
    markDecision,
    ensureApplicationPath,
    findInstructionConsent,
    consumeInstructionConsent,
    validateTarget,
  };
}
