import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import type {
  IssueExecutionPolicy,
  IssueExecutionState,
  IssueExecutionStagePrincipal,
} from "@paperclipai/shared";
import { resolveSdlcGovernance, type SdlcEvidenceRecord } from "./sdlc-lifecycle.js";

type DbOrTx = Pick<Db, "select">;

type IssueLike = {
  id: string;
  companyId: string;
  parentId: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

export type TerminalReviewerRoutingSource =
  | {
      kind: "review_issue";
      issueId: string;
      identifier: string | null;
    }
  | {
      kind: "qa_verdict";
      recordId: string;
      verdict: string;
    };

export type TerminalReviewerRouting = {
  policy: IssueExecutionPolicy;
  participant: IssueExecutionStagePrincipal;
  reviewRequest: NonNullable<IssueExecutionState["reviewRequest"]>;
  source: TerminalReviewerRoutingSource;
};

function principalsEqual(
  left: IssueExecutionStagePrincipal | null,
  right: IssueExecutionStagePrincipal | null,
): boolean {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent"
    ? left.agentId === right.agentId
    : left.userId === right.userId;
}

function issueAssigneePrincipal(issue: Pick<IssueLike, "assigneeAgentId" | "assigneeUserId">) {
  if (issue.assigneeAgentId) {
    return { type: "agent", agentId: issue.assigneeAgentId, userId: null } satisfies IssueExecutionStagePrincipal;
  }
  if (issue.assigneeUserId) {
    return { type: "user", agentId: null, userId: issue.assigneeUserId } satisfies IssueExecutionStagePrincipal;
  }
  return null;
}

function isReviewIssueText(title: string, description: string | null): boolean {
  const text = `${title}\n${description ?? ""}`;
  return /\bqa\b|\breview(?:er|ing)?\b|\bvalidat(?:e|es|ed|ing|ion)\b/i.test(text);
}

function readRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordIsSuperseded(records: SdlcEvidenceRecord[], record: SdlcEvidenceRecord): boolean {
  return records.some((candidate) => candidate.supersedeOf === record.id);
}

function latestIndependentVerdict(
  records: SdlcEvidenceRecord[],
  issueId: string,
  implementer: IssueExecutionStagePrincipal,
): SdlcEvidenceRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type !== "qa_verdict" || recordIsSuperseded(records, record)) continue;
    const targetIssueId = readRecordString(record, "childIssueId") ?? record.issueId;
    if (targetIssueId !== issueId) continue;
    const verdict = readRecordString(record, "verdict")?.toLowerCase();
    if (verdict !== "pass" && verdict !== "fail") continue;
    const participant = verdictParticipant(record);
    if (participant && !principalsEqual(participant, implementer)) return record;
  }
  return null;
}

function verdictParticipant(record: SdlcEvidenceRecord): IssueExecutionStagePrincipal | null {
  const agentId = readRecordString(record, "reviewerAgentId") ?? record.actorAgentId ?? null;
  if (agentId) return { type: "agent", agentId, userId: null };
  const userId = readRecordString(record, "reviewerUserId");
  return userId ? { type: "user", agentId: null, userId } : null;
}

async function resolveReviewIssueParticipant(
  dbOrTx: DbOrTx,
  issue: IssueLike,
  implementer: IssueExecutionStagePrincipal,
): Promise<{
  participant: IssueExecutionStagePrincipal;
  source: Extract<TerminalReviewerRoutingSource, { kind: "review_issue" }>;
} | null> {
  const candidates = await dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .innerJoin(
      issueRelations,
      and(
        eq(issueRelations.companyId, issue.companyId),
        eq(issueRelations.issueId, issues.id),
        eq(issueRelations.relatedIssueId, issue.id),
        eq(issueRelations.type, "blocks"),
      ),
    )
    .where(and(
      eq(issues.companyId, issue.companyId),
      eq(issues.parentId, issue.id),
      eq(issues.status, "done"),
    ))
    .orderBy(desc(issues.updatedAt), asc(issues.id));

  for (const candidate of candidates) {
    if (!isReviewIssueText(candidate.title, candidate.description)) continue;
    const participant = issueAssigneePrincipal(candidate);
    if (!participant || principalsEqual(participant, implementer)) continue;
    return {
      participant,
      source: {
        kind: "review_issue",
        issueId: candidate.id,
        identifier: candidate.identifier,
      },
    };
  }
  return null;
}

function policyHasConfiguredStages(policy: IssueExecutionPolicy | null): boolean {
  return Boolean(policy && policy.stages.length > 0);
}

function policyForParticipant(
  issue: IssueLike,
  participant: IssueExecutionStagePrincipal,
  basePolicy: IssueExecutionPolicy | null,
): IssueExecutionPolicy {
  return {
    mode: basePolicy?.mode ?? "normal",
    commentRequired: true,
    stages: [{
      id: issue.id,
      type: "review",
      approvalsNeeded: 1,
      participants: [{
        id: issue.id,
        type: participant.type,
        agentId: participant.type === "agent" ? participant.agentId ?? null : null,
        userId: participant.type === "user" ? participant.userId ?? null : null,
      }],
    }],
    ...(basePolicy?.monitor ? { monitor: basePolicy.monitor } : {}),
    ...(basePolicy?.reviewPreset ? { reviewPreset: basePolicy.reviewPreset } : {}),
    ...(basePolicy?.authorizationPolicy ? { authorizationPolicy: basePolicy.authorizationPolicy } : {}),
    ...(basePolicy?.admission ? { admission: basePolicy.admission } : {}),
    ...(basePolicy?.maxReviewRounds != null ? { maxReviewRounds: basePolicy.maxReviewRounds } : {}),
  };
}

function reviewInstructions(source: TerminalReviewerRoutingSource): string {
  if (source.kind === "review_issue") {
    const label = source.identifier ?? source.issueId;
    return `Independent review ${label} is complete. Record the terminal verdict: approve to complete this issue, or request changes with the adverse findings.`;
  }
  return `Independent QA verdict ${source.recordId} is ${source.verdict.toUpperCase()}. Record the terminal verdict: approve to complete this issue, or request changes with the adverse findings.`;
}

/**
 * Binds a real non-implementer participant when implementation work enters
 * review without an explicit execution-policy stage. Explicitly configured
 * stages remain authoritative. The fallback order is a completed independent
 * review child and then the latest independent SDLC QA verdict.
 */
export async function resolveTerminalReviewerRouting(
  dbOrTx: DbOrTx,
  input: {
    issue: IssueLike;
    requestedStatus?: string;
    policy: IssueExecutionPolicy | null;
  },
): Promise<TerminalReviewerRouting | null> {
  if (
    input.requestedStatus !== "in_review"
    || input.issue.status === "in_review"
    || policyHasConfiguredStages(input.policy)
  ) {
    return null;
  }
  const implementer = issueAssigneePrincipal(input.issue);
  if (!implementer) return null;

  const reviewIssue = await resolveReviewIssueParticipant(dbOrTx, input.issue, implementer);
  if (reviewIssue) {
    return {
      policy: policyForParticipant(input.issue, reviewIssue.participant, input.policy),
      participant: reviewIssue.participant,
      reviewRequest: { instructions: reviewInstructions(reviewIssue.source) },
      source: reviewIssue.source,
    };
  }

  const governance = await resolveSdlcGovernance(dbOrTx, input.issue);
  if (!governance) return null;
  const verdict = latestIndependentVerdict(governance.records, input.issue.id, implementer);
  const participant = verdict ? verdictParticipant(verdict) : null;
  if (!verdict || !participant) return null;
  const source = {
    kind: "qa_verdict" as const,
    recordId: verdict.id,
    verdict: readRecordString(verdict, "verdict")!.toLowerCase(),
  };
  return {
    policy: policyForParticipant(input.issue, participant, input.policy),
    participant,
    reviewRequest: { instructions: reviewInstructions(source) },
    source,
  };
}
