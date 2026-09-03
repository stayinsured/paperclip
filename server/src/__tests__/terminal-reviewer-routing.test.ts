import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  appendSdlcEvidenceRecords,
  buildSdlcEvidenceRecord,
} from "../services/sdlc-lifecycle.ts";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.ts";
import { issueService } from "../services/issues.ts";
import { resolveTerminalReviewerRouting } from "../services/terminal-reviewer-routing.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("explicit terminal reviewer routing (STA-2902)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-reviewer-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS "issue_relations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL,
        "issue_id" uuid NOT NULL,
        "related_issue_id" uuid NOT NULL,
        "type" text NOT NULL,
        "created_by_agent_id" uuid,
        "created_by_user_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issueDocuments);
    await db.delete(issues);
    await db.delete(documents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal reviewer replay",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, role: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `${role}-${id.slice(0, 6)}`,
      role,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(input: {
    companyId: string;
    title: string;
    status: "in_progress" | "done";
    assigneeAgentId: string;
    parentId?: string | null;
    description?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      parentId: input.parentId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
    });
    return id;
  }

  async function seedIndependentReview(title: string) {
    const companyId = await seedCompany();
    const implementerAgentId = await seedAgent(companyId, "engineer");
    const reviewerAgentId = await seedAgent(companyId, "qa");
    const implementationIssueId = await seedIssue({
      companyId,
      title: "Implementation issue",
      status: "in_progress",
      assigneeAgentId: implementerAgentId,
    });
    const reviewIssueId = await seedIssue({
      companyId,
      title,
      status: "done",
      assigneeAgentId: reviewerAgentId,
      parentId: implementationIssueId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: reviewIssueId,
      relatedIssueId: implementationIssueId,
      type: "blocks",
    });
    return { companyId, implementerAgentId, reviewerAgentId, implementationIssueId, reviewIssueId };
  }

  async function advanceAsReviewer(input: {
    implementationIssueId: string;
    reviewerAgentId: string;
    requestedStatus: "done" | "in_progress";
    commentBody: string;
  }) {
    const issue = await svc.getById(input.implementationIssueId);
    expect(issue).not.toBeNull();
    const policy = normalizeIssueExecutionPolicy(issue!.executionPolicy);
    const transition = applyIssueExecutionPolicyTransition({
      issue: issue!,
      policy,
      requestedStatus: input.requestedStatus,
      requestedAssigneePatch: {},
      actor: { agentId: input.reviewerAgentId },
      commentBody: input.commentBody,
    });
    return svc.update(input.implementationIssueId, {
      ...transition.patch,
      status: input.requestedStatus,
      actorAgentId: input.reviewerAgentId,
    });
  }

  it.each([
    "QA review - lifecycle gates",
    "Independently validate the ClickUp mirror",
    "QA Board workflow and evidence panel",
  ])("closes replay %s through its non-implementer participant", async (reviewTitle) => {
    const replay = await seedIndependentReview(reviewTitle);
    const inReview = await svc.update(replay.implementationIssueId, {
      status: "in_review",
      actorAgentId: replay.implementerAgentId,
    });

    expect(inReview).toMatchObject({
      status: "in_review",
      assigneeAgentId: replay.reviewerAgentId,
      assigneeUserId: null,
    });
    expect(parseIssueExecutionState(inReview!.executionState)).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: replay.reviewerAgentId },
      returnAssignee: { type: "agent", agentId: replay.implementerAgentId },
      reviewRequest: {
        instructions: expect.stringContaining("approve to complete this issue"),
      },
    });

    const closed = await advanceAsReviewer({
      implementationIssueId: replay.implementationIssueId,
      reviewerAgentId: replay.reviewerAgentId,
      requestedStatus: "done",
      commentBody: "Independent review PASS. Approve completion.",
    });
    expect(closed?.status).toBe("done");
  });

  it("keeps self-approval rejected after the independent reviewer is bound", async () => {
    const replay = await seedIndependentReview("QA review - self approval guard");
    const inReview = await svc.update(replay.implementationIssueId, {
      status: "in_review",
      actorAgentId: replay.implementerAgentId,
    });

    expect(() => applyIssueExecutionPolicyTransition({
      issue: inReview!,
      policy: normalizeIssueExecutionPolicy(inReview!.executionPolicy),
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: replay.implementerAgentId },
      commentBody: "Approve my own work.",
    })).toThrow("Only the active reviewer or approver can advance the current execution stage");
  });

  it("lets an adverse review verdict finish and routes changes back without blocking", async () => {
    const replay = await seedIndependentReview("QA review - adverse findings");
    await svc.update(replay.implementationIssueId, {
      status: "in_review",
      actorAgentId: replay.implementerAgentId,
    });

    const returned = await advanceAsReviewer({
      implementationIssueId: replay.implementationIssueId,
      reviewerAgentId: replay.reviewerAgentId,
      requestedStatus: "in_progress",
      commentBody: "Adverse finding: retry handling needs correction.",
    });
    expect(returned).toMatchObject({
      status: "in_progress",
      assigneeAgentId: replay.implementerAgentId,
      assigneeUserId: null,
    });
    expect(parseIssueExecutionState(returned!.executionState)).toMatchObject({
      status: "changes_requested",
      lastDecisionOutcome: "changes_requested",
    });
  });

  it("falls back to an independent governed QA verdict actor", async () => {
    const companyId = await seedCompany();
    const coordinatorAgentId = await seedAgent(companyId, "cto");
    const implementerAgentId = await seedAgent(companyId, "engineer");
    const reviewerAgentId = await seedAgent(companyId, "qa");
    const rootIssueId = await seedIssue({
      companyId,
      title: "Governed root",
      status: "in_progress",
      assigneeAgentId: coordinatorAgentId,
    });
    const implementationIssueId = await seedIssue({
      companyId,
      title: "Governed implementation",
      status: "in_progress",
      assigneeAgentId: implementerAgentId,
      parentId: rootIssueId,
    });
    await appendSdlcEvidenceRecords(db, rootIssueId, [
      buildSdlcEvidenceRecord({
        id: `evd:classification:${rootIssueId}`,
        type: "classification",
        companyId,
        issueId: rootIssueId,
      }, { class: "C1" }),
      buildSdlcEvidenceRecord({
        id: `evd:qa:${implementationIssueId}`,
        type: "qa_verdict",
        companyId,
        issueId: rootIssueId,
        actor: { agentId: reviewerAgentId },
      }, { childIssueId: implementationIssueId, verdict: "pass", rowIds: [] }),
    ]);

    const implementation = await svc.getById(implementationIssueId);
    const routing = await resolveTerminalReviewerRouting(db, {
      issue: implementation!,
      requestedStatus: "in_review",
      policy: null,
    });
    expect(routing).toMatchObject({
      participant: { type: "agent", agentId: reviewerAgentId },
      source: { kind: "qa_verdict", recordId: `evd:qa:${implementationIssueId}`, verdict: "pass" },
    });
  });

  it("keeps an explicitly configured reviewer authoritative", async () => {
    const replay = await seedIndependentReview("QA review - configured override");
    const configuredReviewerAgentId = await seedAgent(replay.companyId, "security");
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: configuredReviewerAgentId }] }],
    });
    const implementation = await db
      .select()
      .from(issues)
      .where(eq(issues.id, replay.implementationIssueId))
      .then((rows) => rows[0]!);

    await expect(resolveTerminalReviewerRouting(db, {
      issue: implementation,
      requestedStatus: "in_review",
      policy,
    })).resolves.toBeNull();
    const transition = applyIssueExecutionPolicyTransition({
      issue: implementation,
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: replay.implementerAgentId },
    });
    expect(transition.patch).toMatchObject({
      assigneeAgentId: configuredReviewerAgentId,
      executionState: {
        currentParticipant: { type: "agent", agentId: configuredReviewerAgentId },
      },
    });
  });
});
