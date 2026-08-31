import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  agents,
  createDb,
  documents,
  issueDocuments,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { createAcceptedPlanDecompositionSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.ts";
import { issueService } from "../services/issues.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.ts";
import {
  appendSdlcEvidenceRecords,
  buildSdlcTaskIdempotencyKey,
  buildSdlcEvidenceRecord,
  evaluateSdlcActivationCandidates,
  parseSdlcEvidenceRegistry,
  parseSdlcGateIdempotencyKey,
  readSdlcIssueDocument,
  recordSdlcGateDecision,
  recordSdlcProvisioningComplete,
  SDLC_EVIDENCE_DOCUMENT_KEY,
} from "../services/sdlc-lifecycle.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SDLC lifecycle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CHILD_DESCRIPTION = [
  "Provisioned from the approved plan.",
  "",
  "## Acceptance Criteria",
  "",
  "- Guard rejects starts before Gate 2",
  "- Guard rejects stale approvals",
].join("\n");

const PLAN_BODY = [
  "# Initiative plan",
  "",
  "## Overview",
  "",
  "Company-wide enforcement.",
  "",
  "## Tasks",
  "",
  "- Task A",
  "- Task B",
  "",
  "## Acceptance Criteria",
  "",
  "- No task starts before Gate 2",
].join("\n");

describe("sdlc gate idempotency key grammar", () => {
  it("parses gate 1 and gate 2 keys", () => {
    const issueId = randomUUID();
    const revisionId = randomUUID();
    expect(parseSdlcGateIdempotencyKey(`confirmation:${issueId}:plan:${revisionId}`)).toEqual({
      gate: "gate1",
      issueId,
      revisionId,
      graphRev: null,
    });
    expect(parseSdlcGateIdempotencyKey(`confirmation:${issueId}:start:${revisionId}:g2`)).toEqual({
      gate: "gate2",
      issueId,
      revisionId,
      graphRev: 2,
    });
    expect(parseSdlcGateIdempotencyKey("confirmation:other")).toBeNull();
    expect(parseSdlcGateIdempotencyKey(null)).toBeNull();
  });
});

describe("sdlc provisioning request contract", () => {
  it("accepts an unassigned backlog DAG with stable task keys", () => {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const result = createAcceptedPlanDecompositionSchema.safeParse({
      acceptedPlanRevisionId: randomUUID(),
      children: [
        { title: "A", status: "backlog" },
        { title: "B", status: "backlog" },
      ],
      sdlc: {
        graphRev: 1,
        tasks: [
          { taskKey: "A", plannedAssigneeAgentId: ownerA },
          { taskKey: "B", plannedAssigneeAgentId: ownerB, blockedByTaskKeys: ["A"] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects cycles and assigned or active provisioned children", () => {
    const owner = randomUUID();
    const result = createAcceptedPlanDecompositionSchema.safeParse({
      acceptedPlanRevisionId: randomUUID(),
      children: [
        { title: "A", status: "todo", assigneeAgentId: owner },
        { title: "B", status: "backlog" },
      ],
      sdlc: {
        graphRev: 1,
        tasks: [
          { taskKey: "A", plannedAssigneeAgentId: owner, blockedByTaskKeys: ["B"] },
          { taskKey: "B", plannedAssigneeAgentId: owner, blockedByTaskKeys: ["A"] },
        ],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "SDLC-provisioned children must start unassigned in backlog",
        "SDLC task dependencies must form an acyclic graph",
      ]));
    }
  });
});

describeEmbeddedPostgres("sdlc lifecycle guards (STA-2781)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sdlc-lifecycle-");
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
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(activityLog);
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
      name: "Paperclip SDLC",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, role = "engineer") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `${role}-${id.slice(0, 8)}`,
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
    parentId?: string | null;
    status?: string;
    description?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      parentId: input.parentId ?? null,
      title: `SDLC issue ${id.slice(0, 8)}`,
      description: input.description ?? null,
      status: input.status ?? "backlog",
      priority: "medium",
    });
    return id;
  }

  async function seedPlanDocument(companyId: string, rootIssueId: string, body = PLAN_BODY) {
    const result = await documentService(db).upsertIssueDocument({
      issueId: rootIssueId,
      key: "plan",
      title: "Initiative plan",
      format: "markdown",
      body,
      createdByUserId: "board-user",
    });
    return result.document;
  }

  async function seedGovernedTree() {
    const companyId = await seedCompany();
    const rootIssueId = await seedIssue({ companyId, status: "in_progress" });
    const childIssueId = await seedIssue({
      companyId,
      parentId: rootIssueId,
      description: CHILD_DESCRIPTION,
    });
    const plan = await seedPlanDocument(companyId, rootIssueId);
    await appendSdlcEvidenceRecords(db, rootIssueId, [
      buildSdlcEvidenceRecord(
        {
          id: `evd:classification:${companyId}:${rootIssueId}`,
          type: "classification",
          companyId,
          issueId: rootIssueId,
        },
        { class: "C2", proposedBy: "specialty-lead", confirmedBy: "cto", policyVersion: "1.0" },
      ),
    ]);
    return { companyId, rootIssueId, childIssueId, planRevisionId: plan.latestRevisionId ?? "" };
  }

  async function acceptGateOne(input: {
    companyId: string;
    rootIssueId: string;
    revisionId: string;
  }) {
    const record = await recordSdlcGateDecision(db, {
      companyId: input.companyId,
      issueId: input.rootIssueId,
      binding: {
        gate: "gate1",
        issueId: input.rootIssueId,
        revisionId: input.revisionId,
        graphRev: null,
      },
      verdict: "accepted",
      confirmationToken: randomUUID(),
      actor: { userId: "board-user" },
    });
    expect(record).not.toBeNull();
  }

  async function acceptGateTwo(input: {
    companyId: string;
    rootIssueId: string;
    revisionId: string;
    graphRev?: number;
  }) {
    await acceptGateOne(input);
    await appendSdlcEvidenceRecords(db, input.rootIssueId, [
      buildSdlcEvidenceRecord(
        {
          id: `evd:prov:${input.companyId}:${input.rootIssueId}:g${input.graphRev ?? 1}`,
          type: "provisioning_complete",
          companyId: input.companyId,
          issueId: input.rootIssueId,
        },
        { graphRev: String(input.graphRev ?? 1), children: [], verifiedAt: new Date().toISOString() },
      ),
    ]);
    const record = await recordSdlcGateDecision(db, {
      companyId: input.companyId,
      issueId: input.rootIssueId,
      binding: {
        gate: "gate2",
        issueId: input.rootIssueId,
        revisionId: input.revisionId,
        graphRev: input.graphRev ?? 1,
      },
      verdict: "accepted",
      confirmationToken: randomUUID(),
      actor: { userId: "board-user" },
    });
    expect(record).not.toBeNull();
  }

  it("AC1: rejects implementation starts before Gate 2 acceptance", async () => {
    const { childIssueId } = await seedGovernedTree();
    const rejection = await svc.update(childIssueId, { status: "todo" }).catch((error) => error);
    expect(rejection.status).toBe(409);
    expect(rejection.details).toMatchObject({ code: "sdlc_gate2_required", gate: "gate2" });
    const [unchanged] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, childIssueId));
    expect(unchanged.status).toBe("backlog");
  });

  it("AC1: allows starts after Gate 2 acceptance bound to the current revision", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId });
    const updated = await svc.update(childIssueId, { status: "todo" });
    expect(updated?.status).toBe("todo");
  });

  it("AC1: emergency record permits start without gates", async () => {
    const { companyId, rootIssueId, childIssueId } = await seedGovernedTree();
    const authorizerAgentId = await seedAgent(companyId, "cto");
    await documentService(db).upsertIssueDocument({
      issueId: childIssueId,
      key: "sdlc-emergency",
      title: "SDLC emergency record",
      format: "markdown",
      body: JSON.stringify({
        severity: "sev1",
        incidentOwner: "specialty-lead",
        authorizerAgentId,
        authorizedAt: new Date().toISOString(),
        rollbackRef: "runbook://incident-1",
        backfillStatus: "open",
      }),
      createdByAgentId: authorizerAgentId,
    });
    const updated = await svc.update(childIssueId, { status: "todo" });
    expect(updated?.status).toBe("todo");
    expect(rootIssueId).toBeTruthy();
  });

  it("AC2: rejects activation when the plan was revised after Gate 2 acceptance", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId });
    const revised = await documentService(db).upsertIssueDocument({
      issueId: rootIssueId,
      key: "plan",
      title: "Initiative plan",
      format: "markdown",
      body: `${PLAN_BODY}\n\n## Revision 2\n\n- Tightened scope\n`,
      baseRevisionId: planRevisionId,
      createdByUserId: "board-user",
    });
    const rejection = await svc.update(childIssueId, { status: "todo" }).catch((error) => error);
    expect(rejection.status).toBe(409);
    expect(rejection.details).toMatchObject({
      code: "sdlc_stale_plan_revision",
      boundRevisionId: planRevisionId,
      currentRevisionId: revised.document.latestRevisionId,
    });
  });

  it("AC2: rejects activation when the provisioned graph moved past the gate binding", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId, graphRev: 1 });
    await appendSdlcEvidenceRecords(db, rootIssueId, [
      buildSdlcEvidenceRecord(
        {
          id: `evd:prov:${companyId}:${rootIssueId}:g2`,
          type: "provisioning_complete",
          companyId,
          issueId: rootIssueId,
        },
        { graphRev: "2", children: [], verifiedAt: new Date().toISOString() },
      ),
    ]);
    const rejection = await svc.update(childIssueId, { status: "todo" }).catch((error) => error);
    expect(rejection.status).toBe(409);
    expect(rejection.details).toMatchObject({ code: "sdlc_stale_graph_rev" });
  });

  it("AC3: done is rejected with explicit missing rows, then passes with row evidence", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId });
    await svc.update(childIssueId, { status: "todo" });

    const rejection = await svc.update(childIssueId, { status: "done" }).catch((error) => error);
    expect(rejection.status).toBe(422);
    const missingRows = (rejection.details as { missingRows: Array<{ rowId: string }> }).missingRows;
    expect(missingRows.map((row) => row.rowId)).toEqual(["ac-1", "ac-2"]);
    expect(missingRows[0]).toMatchObject({
      text: "Guard rejects starts before Gate 2",
      requiredEvidence: "check_result | qa_verdict | uat_evidence | waiver",
    });

    await appendSdlcEvidenceRecords(db, rootIssueId, [
      buildSdlcEvidenceRecord(
        {
          id: `evd:qa:${companyId}:${childIssueId}`,
          type: "qa_verdict",
          companyId,
          issueId: rootIssueId,
        },
        { childIssueId, verdict: "pass", rowIds: ["ac-1", "ac-2"], evidenceUrl: "https://example.com/qa" },
      ),
    ]);
    const done = await svc.update(childIssueId, { status: "done" });
    expect(done?.status).toBe("done");
  });

  it("AC3: root done lists non-terminal descendants explicitly", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId });
    await svc.update(childIssueId, { status: "todo" });
    const rejection = await svc.update(rootIssueId, { status: "done" }).catch((error) => error);
    expect(rejection.status).toBe(422);
    const missingRows = (rejection.details as { missingRows: Array<{ rowId: string }> }).missingRows;
    const rowIds = missingRows.map((row) => row.rowId);
    expect(rowIds).toContain(`descendant:${childIssueId}`);
    expect(rowIds.some((rowId) => rowId.startsWith("descendant:"))).toBe(true);
  });

  it("AC3: waiver rows satisfy closure", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId });
    await svc.update(childIssueId, { status: "todo" });
    await appendSdlcEvidenceRecords(db, rootIssueId, [
      buildSdlcEvidenceRecord(
        {
          id: `evd:waiver:${companyId}:${childIssueId}`,
          type: "waiver",
          companyId,
          issueId: rootIssueId,
        },
        { childIssueId, rowId: "ac-1", owner: "cto", rationale: "covered elsewhere" },
      ),
      buildSdlcEvidenceRecord(
        {
          id: `evd:check:${companyId}:${childIssueId}`,
          type: "check_result",
          companyId,
          issueId: rootIssueId,
        },
        { childIssueId, suite: "focused", result: "pass", rowIds: ["ac-2"] },
      ),
    ]);
    const done = await svc.update(childIssueId, { status: "done" });
    expect(done?.status).toBe("done");
  });

  it("AC3: open emergency backfill blocks done", async () => {
    const { companyId, rootIssueId, childIssueId } = await seedGovernedTree();
    const authorizerAgentId = await seedAgent(companyId, "ceo");
    await documentService(db).upsertIssueDocument({
      issueId: childIssueId,
      key: "sdlc-emergency",
      title: "SDLC emergency record",
      format: "markdown",
      body: JSON.stringify({
        severity: "sev1",
        authorizerAgentId,
        authorizedAt: new Date().toISOString(),
        backfillStatus: "open",
      }),
      createdByAgentId: authorizerAgentId,
    });
    await svc.update(childIssueId, { status: "todo" });
    const rejection = await svc.update(childIssueId, { status: "done" }).catch((error) => error);
    expect(rejection.status).toBe(422);
    const missingRows = (rejection.details as { missingRows: Array<{ rowId: string }> }).missingRows;
    expect(missingRows.map((row) => row.rowId)).toContain("emergency:backfill");
  });

  it("AC4: evidence append retries do not duplicate records", async () => {
    const { companyId, rootIssueId } = await seedGovernedTree();
    const record = buildSdlcEvidenceRecord(
      {
        id: `evd:obs:${companyId}:${rootIssueId}`,
        type: "check_result",
        companyId,
        issueId: rootIssueId,
      },
      { childIssueId: rootIssueId, suite: "focused", result: "pass", rowIds: [] },
    );
    const first = await appendSdlcEvidenceRecords(db, rootIssueId, [record]);
    expect(first.appended).toHaveLength(1);
    const second = await appendSdlcEvidenceRecords(db, rootIssueId, [record]);
    expect(second.appended).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    const registry = await readSdlcIssueDocument(db, rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY);
    const parsed = parseSdlcEvidenceRegistry(registry?.body);
    expect(parsed.filter((entry) => entry.id === record.id)).toHaveLength(1);
  });

  it("AC4: stable SDLC task keys reuse the same child on retry", async () => {
    const { rootIssueId } = await seedGovernedTree();
    const idempotencyKey = buildSdlcTaskIdempotencyKey(rootIssueId, "implementation");
    const first = await svc.createChild(rootIssueId, {
      title: "Provision exactly once",
      status: "backlog",
      priority: "medium",
      idempotencyKey,
    });
    const second = await svc.createChild(rootIssueId, {
      title: "Provision exactly once",
      status: "backlog",
      priority: "medium",
      idempotencyKey,
    });
    expect(second.issue.id).toBe(first.issue.id);
    const matchingChildren = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.parentId, rootIssueId));
    expect(matchingChildren.filter((child) => child.id === first.issue.id)).toHaveLength(1);
  });

  it("accepts Gate 2 atomically with planned-owner activation and retry-safe evidence", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    const coordinatorAgentId = await seedAgent(companyId, "cto");
    const plannedAssigneeAgentId = await seedAgent(companyId);
    await acceptGateOne({ companyId, rootIssueId, revisionId: planRevisionId });
    const provisioningInput = {
      companyId,
      rootIssueId,
      revisionId: planRevisionId,
      graphRev: 1,
      tasks: [{
        taskKey: "implementation",
        childIssueId,
        plannedAssigneeAgentId,
        blockedByTaskKeys: [],
      }],
      actor: { agentId: coordinatorAgentId },
    };
    await recordSdlcProvisioningComplete(db, provisioningInput);
    await recordSdlcProvisioningComplete(db, provisioningInput);
    const alternateOwnerAgentId = await seedAgent(companyId);
    await expect(recordSdlcProvisioningComplete(db, {
      ...provisioningInput,
      tasks: [{
        ...provisioningInput.tasks[0],
        plannedAssigneeAgentId: alternateOwnerAgentId,
      }],
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "sdlc_graph_revision_conflict" },
    });
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coordinatorAgentId,
    }).where(eq(issues.id, rootIssueId));

    const interactions = issueThreadInteractionService(db);
    const gate = await interactions.create({ id: rootIssueId, companyId }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      resolverPolicy: "board_only",
      idempotencyKey: `confirmation:${rootIssueId}:start:${planRevisionId}:g1`,
      payload: {
        version: 1,
        prompt: "Authorize implementation?",
        acceptLabel: "Authorize",
        rejectLabel: "Hold",
      },
    }, { userId: "board-user" });

    const accepted = await interactions.acceptInteraction({
      id: rootIssueId,
      companyId,
      projectId: null,
      goalId: null,
    }, gate.id, {}, { userId: "board-user" });
    expect(accepted.createdIssues).toEqual([expect.objectContaining({
      id: childIssueId,
      assigneeAgentId: plannedAssigneeAgentId,
      status: "todo",
    })]);
    expect(accepted.continuationIssue).toMatchObject({ id: rootIssueId, status: "in_progress" });

    const [activatedChild] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, childIssueId));
    expect(activatedChild).toEqual({ status: "todo", assigneeAgentId: plannedAssigneeAgentId });

    await expect(interactions.acceptInteraction({
      id: rootIssueId,
      companyId,
      projectId: null,
      goalId: null,
    }, gate.id, {}, { userId: "board-user" })).rejects.toMatchObject({ status: 409 });

    const registry = parseSdlcEvidenceRegistry(
      (await readSdlcIssueDocument(db, rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY))?.body,
    );
    expect(registry.filter((record) => record.type === "provisioning_complete")).toHaveLength(1);
    expect(registry.filter((record) => record.type === "gate_request" && record.gate === "gate2")).toHaveLength(1);
    expect(registry.filter((record) => record.type === "gate_decision" && record.gate === "gate2")).toHaveLength(1);
    expect(registry.filter((record) => record.type === "activation" && record.childIssueId === childIssueId)).toHaveLength(1);
  });

  it("AC4: activation evaluator skips blocked, busy, and already-activated children", async () => {
    const { companyId, rootIssueId, childIssueId, planRevisionId } = await seedGovernedTree();
    const childA = await seedIssue({ companyId, parentId: rootIssueId });
    const childB = await seedIssue({ companyId, parentId: rootIssueId });
    const childC = await seedIssue({ companyId, parentId: rootIssueId });
    const blockerForB = await seedIssue({ companyId, status: "in_progress" });
    const plannedOwners = new Map([
      [childIssueId, await seedAgent(companyId)],
      [childA, await seedAgent(companyId)],
      [childB, await seedAgent(companyId)],
      [childC, await seedAgent(companyId)],
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerForB,
      relatedIssueId: childB,
      type: "blocks",
    });
    await acceptGateTwo({ companyId, rootIssueId, revisionId: planRevisionId });
    await appendSdlcEvidenceRecords(db, rootIssueId, [
      ...[childIssueId, childA, childB, childC].map((provisionedChildId, index) => buildSdlcEvidenceRecord(
        {
          id: `evd:prov-write:${companyId}:${rootIssueId}:g1:task-${index + 1}`,
          type: "provisioning_write",
          companyId,
          issueId: rootIssueId,
        },
        {
          provider: "paperclip",
          op: "provision_task",
          graphRev: "1",
          taskKey: `task-${index + 1}`,
          childIssueId: provisionedChildId,
          plannedAssigneeAgentId: plannedOwners.get(provisionedChildId),
          outcome: "verified",
        },
      )),
      buildSdlcEvidenceRecord(
        {
          id: `evd:activation:${companyId}:${childC}:${rootIssueId}`,
          type: "activation",
          companyId,
          issueId: rootIssueId,
        },
        { childIssueId: childC, agentId: null, order: "1" },
      ),
    ]);
    const { candidates } = await evaluateSdlcActivationCandidates(db, rootIssueId);
    expect(candidates.map((candidate) => candidate.child.id)).toEqual([childIssueId, childA]);
  });

  it("leaves non-governed trees completely unaffected", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue({ companyId });
    const updated = await svc.update(issueId, { status: "todo" });
    expect(updated?.status).toBe("todo");
    const done = await svc.update(issueId, { status: "done" });
    expect(done?.status).toBe("done");
  });
});
