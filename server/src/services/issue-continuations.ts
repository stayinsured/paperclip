import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  IssueNextActionProjection,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import {
  readSdlcIssueDocument,
  resolveSdlcGovernance,
  SDLC_EVIDENCE_DOCUMENT_KEY,
} from "./sdlc-lifecycle.js";

type DbReader = Pick<Db, "select">;

type ContinuationIssue = {
  id: string;
  companyId: string;
  parentId: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionRunId: string | null;
  monitorNextCheckAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  monitorAttemptCount: number;
};

export type IssueContinuationSnapshot = {
  key: string;
  interaction: {
    id: string;
    revision: string;
    kind: string;
    addresseeAgentId: string | null;
  } | null;
  interactionRevisions: Array<{ id: string; revision: string }>;
  evidenceRevisionId: string | null;
  blockerSetRevision: string;
  unresolvedBlockers: Array<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  }>;
  monitorAnchor: string | null;
  governedRootIssueId: string | null;
};

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function readIssueContinuationSnapshot(
  dbOrTx: DbReader,
  issue: ContinuationIssue,
): Promise<IssueContinuationSnapshot> {
  const [interactionRows, blockerRows, governance] = await Promise.all([
    dbOrTx
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        updatedAt: issueThreadInteractions.updatedAt,
      })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id)),
    dbOrTx
      .select({
        relationId: issueRelations.id,
        relationUpdatedAt: issueRelations.updatedAt,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        blockerUpdatedAt: issues.updatedAt,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(and(
        eq(issueRelations.companyId, issue.companyId),
        eq(issueRelations.relatedIssueId, issue.id),
        eq(issueRelations.type, "blocks"),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      ))
      .orderBy(asc(issueRelations.id)),
    resolveSdlcGovernance(dbOrTx, {
      id: issue.id,
      companyId: issue.companyId,
      parentId: issue.parentId,
    }),
  ]);

  const interactionRevisions = interactionRows.map((row) => ({
    id: row.id,
    revision: iso(row.updatedAt)!,
  }));
  const primaryInteraction = interactionRows[0]
    ? {
        id: interactionRows[0].id,
        revision: iso(interactionRows[0].updatedAt)!,
        kind: interactionRows[0].kind,
        addresseeAgentId: interactionRows[0].addresseeAgentId,
      }
    : null;

  const evidenceDocument = governance
    ? await readSdlcIssueDocument(dbOrTx, governance.rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY)
    : null;
  const blockerRevisionInput = blockerRows.map((row) => ({
    relationId: row.relationId,
    relationUpdatedAt: iso(row.relationUpdatedAt),
    blockerId: row.id,
    blockerStatus: row.status,
    blockerUpdatedAt: iso(row.blockerUpdatedAt),
  }));
  const blockerSetRevision = sha256(blockerRevisionInput).slice(0, 24);
  const monitorAnchor = issue.monitorNextCheckAt || issue.monitorLastTriggeredAt
    ? [
        iso(issue.monitorNextCheckAt),
        iso(issue.monitorLastTriggeredAt),
        String(issue.monitorAttemptCount),
      ].join(":")
    : null;
  const evidenceRevisionId = evidenceDocument?.latestRevisionId ?? null;
  const keyInput = {
    issueId: issue.id,
    interactions: interactionRevisions,
    evidenceRevisionId,
    blockerSetRevision,
    monitorAnchor,
  };

  return {
    key: `issue-continuation:v1:${issue.id}:${sha256(keyInput).slice(0, 32)}`,
    interaction: primaryInteraction,
    interactionRevisions,
    evidenceRevisionId,
    blockerSetRevision,
    unresolvedBlockers: blockerRows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
    })),
    monitorAnchor,
    governedRootIssueId: governance?.rootIssueId ?? null,
  };
}


function projectionBase(
  snapshot: IssueContinuationSnapshot,
  kind: IssueNextActionProjection["kind"],
  title: string,
  description: string,
): Pick<IssueNextActionProjection, "kind" | "title" | "description" | "continuationKey"> {
  return {
    kind,
    title,
    description,
    continuationKey: snapshot.key,
  };
}

export function projectIssueNextAction(input: {
  issue: ContinuationIssue;
  snapshot: IssueContinuationSnapshot;
  scheduledRetry?: IssueScheduledRetry | null;
}): IssueNextActionProjection | null {
  const { issue, snapshot, scheduledRetry } = input;
  if (issue.status === "done" || issue.status === "cancelled") return null;

  if (snapshot.interaction) {
    return {
      ...projectionBase(
        snapshot,
        "approval",
        "Decision required",
        `Resolve the pending ${snapshot.interaction.kind.replaceAll("_", " ")} before work continues.`,
      ),
      ownerType: snapshot.interaction.addresseeAgentId ? "agent" : "board",
      ownerId: snapshot.interaction.addresseeAgentId,
      sourceId: snapshot.interaction.id,
      sourceRevision: snapshot.interaction.revision,
      scheduledAt: null,
    };
  }

  if (snapshot.unresolvedBlockers.length > 0) {
    const blocker = snapshot.unresolvedBlockers[0]!;
    return {
      ...projectionBase(
        snapshot,
        "blocker",
        "Blocked by prerequisite work",
        `${blocker.identifier ?? blocker.id}: ${blocker.title}`,
      ),
      ownerType: blocker.assigneeUserId ? "user" : blocker.assigneeAgentId ? "agent" : "board",
      ownerId: blocker.assigneeUserId ?? blocker.assigneeAgentId,
      sourceId: blocker.id,
      sourceRevision: snapshot.blockerSetRevision,
      scheduledAt: null,
    };
  }

  if (issue.monitorNextCheckAt) {
    return {
      ...projectionBase(
        snapshot,
        "monitor",
        "Waiting for monitor",
        "Paperclip will wake the assignee at the persisted monitor anchor.",
      ),
      ownerType: "system",
      ownerId: null,
      sourceId: issue.id,
      sourceRevision: snapshot.monitorAnchor,
      scheduledAt: iso(issue.monitorNextCheckAt),
    };
  }

  if (scheduledRetry?.status === "scheduled_retry") {
    return {
      ...projectionBase(
        snapshot,
        "run_retry",
        "Run retry scheduled",
        "Paperclip will retry the failed run at the scheduled time.",
      ),
      ownerType: "system",
      ownerId: null,
      sourceId: scheduledRetry.runId,
      sourceRevision: `${scheduledRetry.runId}:${scheduledRetry.scheduledRetryAttempt}`,
      scheduledAt: iso(scheduledRetry.scheduledRetryAt),
    };
  }

  if (!issue.executionRunId && snapshot.governedRootIssueId) {
    return {
      ...projectionBase(
        snapshot,
        "evidence",
        "Evidence required",
        "Add or revise the governed evidence document before continuing.",
      ),
      ownerType: issue.assigneeUserId ? "user" : issue.assigneeAgentId ? "agent" : "board",
      ownerId: issue.assigneeUserId ?? issue.assigneeAgentId,
      sourceId: snapshot.governedRootIssueId,
      sourceRevision: snapshot.evidenceRevisionId,
      scheduledAt: null,
    };
  }

  return null;
}
