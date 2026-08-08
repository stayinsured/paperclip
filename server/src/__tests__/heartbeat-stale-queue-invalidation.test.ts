import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  companySkillTestRuns,
  companySkillVersions,
  companySkills,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockSupportedExecutionProfiles = vi.hoisted(() => [] as string[]);

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      supportedExecutionProfiles: mockSupportedExecutionProfiles,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
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
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "company_skills",
          "issue_comments",
          "issue_documents",
          "document_revisions",
          "documents",
          "issue_relations",
          "issue_tree_holds",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const isLateCommentRace =
        error instanceof Error &&
        error.message.includes("issue_comments_issue_id_issues_id_fk");
      if (!isLateCommentRace || attempt === 9) {
        throw error;
      }

      // Heartbeat completion can write issue-thread comments shortly after the
      // run leaves queued/running. Retry the dependent deletes once those land.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockSupportedExecutionProfiles.length = 0;
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    heartbeat = heartbeatService(db);
    await cleanupHeartbeatInvalidationFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedSkillTestHarness(input: {
    companyId: string;
    agentId: string;
    executionProfile: "standard" | "output_only";
  }) {
    const skillId = randomUUID();
    const versionId = randomUUID();
    const testRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId: input.companyId,
      key: "company/test/output-only",
      slug: "output-only",
      name: "Output Only Skill",
      markdown: "# LIVE HEAD",
      sourceType: "local_path",
      sourceLocator: "/missing/live-skill",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    await db.insert(companySkillVersions).values({
      id: versionId,
      companyId: input.companyId,
      companySkillId: skillId,
      revisionNumber: 1,
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# PINNED OUTPUT ONLY" }],
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Output-only harness",
      description: "Return the transformed output.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: input.agentId,
      harnessKind: "skill_test",
      workMode: "skill_test",
      originKind: "skill_test",
      originId: testRunId,
      originFingerprint: `skill_test:${testRunId}`,
    });
    await db.insert(companySkillTestRuns).values({
      id: testRunId,
      companyId: input.companyId,
      skillId,
      inputSnapshot: "Transform this input",
      skillVersionId: versionId,
      agentId: input.agentId,
      agentConfigSnapshot: {},
      issueId,
      harnessIssueDescription: "Transform this input",
      status: "queued",
      executionProfile: input.executionProfile,
      outputDocumentKey: "output",
    });
    const queued = await seedQueuedRun({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId,
      wakeReason: "skill_test_run_created",
    });
    return { skillId, versionId, testRunId, issueId, ...queued };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("rate-limits skipped generic timer wakes by advancing the timer baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(1);
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.reason).toBe("heartbeat.timer.no_actionable_work");
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThan(now.getTime() - 120_000);
  });

  it("atomically claims a due timer interval across overlapping scheduler ticks", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({
        createdAt: new Date(now.getTime() - 120_000),
        lastHeartbeatAt: null,
      })
      .where(eq(agents.id, agentId));

    const results = await Promise.all([
      heartbeat.tickTimers(now),
      heartbeat.tickTimers(now),
    ]);

    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      timerClaimWasFirstHeartbeat: true,
    });
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [deferred] = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      return Boolean(deferred?.runId) && deferred?.status !== "deferred_issue_execution";
    });

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("cancels queued runs when the issue assignee changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "OriginalCoder" });
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "ReplacementCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: replacementAgentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_assignee_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_assignee_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("assignee changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued runs when the issue reaches a terminal status before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already-completed task",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(wakeup?.status).toBe("skipped");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when the issue is no longer in_progress before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked max-turn continuation",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_not_in_progress");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_not_in_progress" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("no longer in_progress");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels queued in_review runs when the current participant changes before the run starts", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task now owned by reviewer",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_review_participant_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_review_participant_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("in-review participant changed");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("still runs comment-driven wakes on in_review issues even when the agent is no longer the current participant", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "In-review task with comment feedback",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: otherAgentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: otherAgentId,
      body: "Review feedback comment",
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
  });

  it("baseline: runs queued runs when the issue is in_progress with the same assignee", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still actionable",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_assigned",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels queued continuation recovery when the continuation summary parks executor work for review", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implementation parked for review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_continuation_waiting_on_review");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_continuation_waiting_on_review" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("continuation summary says the executor should wait");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("runs accepted-interaction continuation recovery despite a pre-acceptance review park", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Approved implementation resumes",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await seedContinuationSummary({
      companyId,
      issueId,
      agentId,
      body: [
        "# Continuation Summary",
        "",
        "## Next Action",
        "",
        "- Wait for reviewer feedback or approval before continuing executor work.",
      ].join("\n"),
    });

    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      contextExtras: {
        retryReason: "issue_continuation_needed",
        mutation: "interaction",
        interactionId: randomUUID(),
        interactionResolvedAt: "2026-03-19T00:05:00.000Z",
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("cancels queued, deferred, and scheduled Skill Studio work before any adapter invocation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled Skill Studio harness",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
      harnessKind: "skill_test",
      workMode: "skill_test",
    });
    const queued = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "skill_test_run_created",
    });
    const scheduled = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
      scheduledRetryReason: "process_lost",
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "scheduled_retry",
        scheduledRetryAt: new Date(Date.now() - 60_000),
      })
      .where(eq(heartbeatRuns.id, scheduled.runId));
    const deferredWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "deferred_issue_execution",
    });

    const cancelled = await heartbeat.cancelIssueInvocations(
      companyId,
      issueId,
      "Cancelled by Skill Studio operator request",
      {
        errorCode: "skill_test_cancelled",
        resultJson: {
          stopReason: "skill_test_cancelled",
          skillTestCancellation: { kind: "operator", issueId },
        },
      },
    );
    await heartbeat.promoteDueScheduledRetries(new Date());
    await heartbeat.resumeQueuedRuns();

    expect(cancelled.cancelledRunIds).toEqual(expect.arrayContaining([queued.runId, scheduled.runId]));
    expect(cancelled.cancelledWakeupIds).toEqual(expect.arrayContaining([
      queued.wakeupRequestId,
      scheduled.wakeupRequestId,
      deferredWakeId,
    ]));
    const persistedRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns);
    expect(persistedRuns).toHaveLength(2);
    for (const run of persistedRuns) {
      expect(run.status).toBe("cancelled");
      expect(run.errorCode).toBe("skill_test_cancelled");
      expect(run.resultJson).toMatchObject({
        stopReason: "skill_test_cancelled",
        skillTestCancellation: { kind: "operator", issueId },
      });
    }
    const persistedWakeups = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests);
    expect(persistedWakeups).toHaveLength(3);
    expect(persistedWakeups.every((wake) => wake.status === "cancelled")).toBe(true);
    expect(countExecuteCallsForRun(queued.runId)).toBe(0);
    expect(countExecuteCallsForRun(scheduled.runId)).toBe(0);
    const [persistedIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(persistedIssue?.status).toBe("cancelled");
  });

  it("cancels a stale persisted Skill Studio heartbeat at dispatch without invoking the adapter", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal Skill Studio harness",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: agentId,
      harnessKind: "skill_test",
      workMode: "skill_test",
    });
    const queued = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "skill_test_run_created",
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued.runId));
      return run?.status === "cancelled";
    });
    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued.runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "skill_test_terminal" });
    expect(countExecuteCallsForRun(queued.runId)).toBe(0);
  });

  it("executes from the persisted pinned skill revision and suppresses only the skill-test continuation summary", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const skillId = randomUUID();
    const versionId = randomUUID();
    const testRunId = randomUUID();
    const skillIssueId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "company/test/pinned",
      slug: "pinned",
      name: "Pinned Skill",
      markdown: "# LIVE HEAD MUST NOT BE USED",
      sourceType: "local_path",
      sourceLocator: "/definitely/missing/live-skill-directory",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    await db.insert(companySkillVersions).values({
      id: versionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 7,
      label: "immutable revision",
      fileInventory: [
        { path: "SKILL.md", kind: "skill", content: "# PINNED REVISION SEVEN\n\nExact immutable content." },
        { path: "references/contract.md", kind: "reference", content: "Pinned contract contents." },
      ],
    });
    await db.insert(issues).values({
      id: skillIssueId,
      companyId,
      title: "Execute pinned skill",
      description: "Use the pinned skill revision.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      harnessKind: "skill_test",
      workMode: "skill_test",
    });
    await db.insert(companySkillTestRuns).values({
      id: testRunId,
      companyId,
      skillId,
      inputSnapshot: "Exercise the pinned revision",
      skillVersionId: versionId,
      agentId,
      agentConfigSnapshot: {},
      issueId: skillIssueId,
      harnessIssueDescription: "Exercise the pinned revision",
      status: "queued",
      outputDocumentKey: "output",
    });
    const skillRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: skillIssueId,
      wakeReason: "skill_test_run_created",
    });
    let skillAdapterInput: any = null;
    mockAdapterExecute.mockImplementationOnce(async (input) => {
      skillAdapterInput = input;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Pinned Skill Studio run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, skillRun.runId));
      return run?.status === "succeeded";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(skillRun.runId);
    const [skillHeartbeat] = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, skillRun.runId));
    expect(skillHeartbeat?.status, JSON.stringify(skillHeartbeat)).toBe("succeeded");
    expect(skillAdapterInput).toEqual(expect.objectContaining({
      runId: skillRun.runId,
      context: expect.objectContaining({
        paperclipTaskMarkdown: expect.any(String),
      }),
    }));
    expect(skillAdapterInput?.context.paperclipTaskMarkdown).toContain("# PINNED REVISION SEVEN");
    expect(skillAdapterInput?.context.paperclipTaskMarkdown).toContain("Pinned contract contents.");
    expect(skillAdapterInput?.context.paperclipTaskMarkdown).not.toContain("LIVE HEAD MUST NOT BE USED");
    expect(skillAdapterInput?.context.paperclipTaskMarkdown).toContain(
      "Do not discover, scan, read, or fetch the live skill directory",
    );
    expect(await db
      .select()
      .from(issueDocuments)
      .where(eq(issueDocuments.issueId, skillIssueId))).toHaveLength(0);

    const ordinaryIssueId = randomUUID();
    await db.insert(issues).values({
      id: ordinaryIssueId,
      companyId,
      title: "Ordinary continuation",
      description: "Continue ordinary work.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const ordinaryRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: ordinaryIssueId,
      wakeReason: "issue_continuation_needed",
      invocationSource: "automation",
    });
    mockAdapterExecute.mockImplementationOnce(async (input) => {
      await db.insert(issueComments).values({
        companyId,
        issueId: ordinaryIssueId,
        body: "Ordinary run left durable progress.",
        authorAgentId: agentId,
        createdByRunId: input.runId,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ordinary run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, ordinaryRun.runId));
      return run?.status === "succeeded";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(ordinaryRun.runId);
    const ordinarySummary = await db
      .select()
      .from(issueDocuments)
      .where(eq(issueDocuments.issueId, ordinaryIssueId));
    expect(ordinarySummary).toEqual([
      expect.objectContaining({ key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY }),
    ]);
  }, 20_000);


  it("dispatches output-only runs with zero external capabilities and server-finalizes only output", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });
    mockSupportedExecutionProfiles.push("skill_test_output_only");
    let adapterInput: any = null;
    let releaseStagedOutput = () => {};
    let markOutputStaged = () => {};
    const outputStaged = new Promise<void>((resolve) => {
      markOutputStaged = resolve;
    });
    const holdAfterStaging = new Promise<void>((resolve) => {
      releaseStagedOutput = resolve;
    });
    heartbeat = heartbeatService(db, {
      testHooks: {
        afterOutputOnlySkillTestOutputStaged: async () => {
          markOutputStaged();
          await holdAfterStaging;
        },
      },
    });
    mockAdapterExecute.mockImplementationOnce(async (input) => {
      adapterInput = input;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Sealed output body.",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();
    await outputStaged;

    const [stagedHeartbeat] = await db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
    const [stagedTestRun] = await db.select({
      status: companySkillTestRuns.status,
      output: companySkillTestRuns.outputSnapshot,
    }).from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    const [stagedHarness] = await db.select({ status: issues.status })
      .from(issues).where(eq(issues.id, harness.issueId));
    expect(stagedHeartbeat?.status).toBe("running");
    expect(stagedTestRun).toEqual({ status: "queued", output: "Sealed output body." });
    expect(stagedHarness?.status).toBe("in_progress");

    const stagedDocuments = await db.select({ key: issueDocuments.key, body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, harness.issueId));
    expect(stagedDocuments).toEqual([{ key: "output", body: "Sealed output body." }]);
    expect(await db.select().from(documentRevisions).where(
      eq(documentRevisions.createdByRunId, harness.runId),
    )).toHaveLength(1);
    const stagedAudits = await db.select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.entityId, harness.testRunId));
    expect(stagedAudits).toEqual([expect.objectContaining({
      action: "company.skill_test_output_staged",
      details: expect.objectContaining({ status: "staged", outputDocumentKey: "output" }),
    })]);

    releaseStagedOutput();
    await waitForCondition(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
      return run?.status === "succeeded";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(harness.runId);

    const replay = await seedQueuedRun({
      companyId,
      agentId,
      issueId: harness.issueId,
      wakeReason: "skill_test_run_created",
    });
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, replay.runId));
      return run?.status === "cancelled";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(replay.runId);

    expect(countExecuteCallsForRun(harness.runId)).toBe(1);
    expect(countExecuteCallsForRun(replay.runId)).toBe(0);
    expect(adapterInput.executionProfile).toEqual({
      kind: "skill_test_output_only",
      testRunId: harness.testRunId,
      issueId: harness.issueId,
      outputDocumentKey: "output",
    });
    expect(adapterInput.runtimeMcp).toBeUndefined();
    expect(adapterInput.authToken).toBeUndefined();
    expect(adapterInput.context.paperclipManagedMcp).toBeUndefined();
    expect(adapterInput.context.paperclipExecutionProfile.kind).toBe("skill_test_output_only");

    const documentRows = await db.select({ key: issueDocuments.key, body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, harness.issueId));
    expect(documentRows).toEqual([{ key: "output", body: "Sealed output body." }]);
    expect(await db.select().from(documentRevisions).where(
      eq(documentRevisions.createdByRunId, harness.runId),
    )).toHaveLength(1);
    const [testRun] = await db.select({ status: companySkillTestRuns.status, output: companySkillTestRuns.outputSnapshot })
      .from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    expect(testRun).toEqual({ status: "succeeded", output: "Sealed output body." });
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, harness.issueId));
    expect(issue?.status).toBe("done");
    const auditRows = await db.select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.entityId, harness.testRunId));
    expect(auditRows).toHaveLength(2);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "company.skill_test_output_staged",
        details: expect.objectContaining({ outputDocumentKey: "output", executionProfile: "output_only" }),
      }),
      expect.objectContaining({
        action: "company.skill_test_run_completed",
        details: expect.objectContaining({ status: "succeeded", heartbeatOutcome: "succeeded" }),
      }),
    ]));
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, harness.issueId))).toHaveLength(0);
  }, 20_000);

  it("keeps staged output when cancellation wins before heartbeat success reconciliation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });
    mockSupportedExecutionProfiles.push("skill_test_output_only");
    let releaseStagedOutput = () => {};
    let markOutputStaged = () => {};
    const outputStaged = new Promise<void>((resolve) => {
      markOutputStaged = resolve;
    });
    const holdAfterStaging = new Promise<void>((resolve) => {
      releaseStagedOutput = resolve;
    });
    heartbeat = heartbeatService(db, {
      testHooks: {
        afterOutputOnlySkillTestOutputStaged: async () => {
          markOutputStaged();
          await holdAfterStaging;
        },
      },
    });
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Output retained after cancellation.",
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.resumeQueuedRuns();
    await outputStaged;

    const cancellationInput = {
      companyId,
      skillId: harness.skillId,
      testRunId: harness.testRunId,
      issueId: harness.issueId,
      agentId,
      reason: "Cancelled by operator",
      options: {
        errorCode: "skill_test_cancelled",
        resultJson: { stopReason: "skill_test_cancelled" },
      },
    };
    expect(await heartbeat.cancelOutputOnlySkillTestRun(cancellationInput)).toBe("cancelled");
    expect(await heartbeat.cancelOutputOnlySkillTestRun(cancellationInput)).toBe("cancelled");
    const [cancelledWakeup] = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, harness.wakeupRequestId));
    expect(cancelledWakeup?.status).toBe("cancelled");
    releaseStagedOutput();
    await heartbeat.waitForRunExecutionDrain(harness.runId);

    const [run] = await db.select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
    expect(run).toEqual({ status: "cancelled", error: "Cancelled by operator" });
    const [testRun] = await db.select({
      status: companySkillTestRuns.status,
      error: companySkillTestRuns.error,
      output: companySkillTestRuns.outputSnapshot,
    }).from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    expect(testRun).toEqual({
      status: "cancelled",
      error: "Cancelled by operator",
      output: "Output retained after cancellation.",
    });
    const [issue] = await db.select({ status: issues.status })
      .from(issues).where(eq(issues.id, harness.issueId));
    expect(issue?.status).toBe("cancelled");
    const outputDocuments = await db.select({ body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, harness.issueId));
    expect(outputDocuments).toEqual([{ body: "Output retained after cancellation." }]);
    expect(await db.select().from(documentRevisions).where(
      eq(documentRevisions.createdByRunId, harness.runId),
    )).toHaveLength(1);
    const auditRows = await db.select({ action: activityLog.action })
      .from(activityLog).where(eq(activityLog.entityId, harness.testRunId));
    expect(auditRows).toEqual([{ action: "company.skill_test_output_staged" }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
  }, 20_000);

  it("returns persisted success when cancellation reaches the linked rows after success holds the locks", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });
    mockSupportedExecutionProfiles.push("skill_test_output_only");
    let releaseTerminalLocks = () => {};
    let markTerminalLocksAcquired = () => {};
    const terminalLocksAcquired = new Promise<void>((resolve) => {
      markTerminalLocksAcquired = resolve;
    });
    const holdTerminalLocks = new Promise<void>((resolve) => {
      releaseTerminalLocks = resolve;
    });
    heartbeat = heartbeatService(db, {
      testHooks: {
        afterOutputOnlySkillTestTerminalLocksAcquired: async () => {
          markTerminalLocksAcquired();
          await holdTerminalLocks;
        },
      },
    });
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Success wins exactly once.",
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.resumeQueuedRuns();
    await terminalLocksAcquired;
    const cancellationInput = {
      companyId,
      skillId: harness.skillId,
      testRunId: harness.testRunId,
      issueId: harness.issueId,
      agentId,
      reason: "Cancelled by operator",
      options: { errorCode: "skill_test_cancelled" },
    };
    const cancellation = heartbeat.cancelOutputOnlySkillTestRun(cancellationInput);
    releaseTerminalLocks();

    expect(await cancellation).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(harness.runId);
    expect(await heartbeat.cancelOutputOnlySkillTestRun(cancellationInput)).toBe("succeeded");

    const [run] = await db.select({ status: heartbeatRuns.status, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, harness.runId));
    const [testRun] = await db.select({
      status: companySkillTestRuns.status,
      output: companySkillTestRuns.outputSnapshot,
    })
      .from(companySkillTestRuns)
      .where(eq(companySkillTestRuns.id, harness.testRunId));
    const [issue] = await db.select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, harness.issueId));
    const [wakeup] = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, harness.wakeupRequestId));
    expect(run).toEqual({ status: "succeeded", retryOfRunId: null });
    expect(testRun).toEqual({ status: "succeeded", output: "Success wins exactly once." });
    expect(issue?.status).toBe("done");
    expect(wakeup?.status).toBe("completed");

    const outputDocuments = await db.select({ body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, harness.issueId));
    expect(outputDocuments).toEqual([{ body: "Success wins exactly once." }]);
    expect(await db.select().from(documentRevisions).where(
      eq(documentRevisions.createdByRunId, harness.runId),
    )).toHaveLength(1);
    const auditRows = await db.select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, harness.testRunId));
    expect(auditRows).toEqual(expect.arrayContaining([
      { action: "company.skill_test_output_staged" },
      { action: "company.skill_test_run_completed" },
    ]));
    expect(auditRows).toHaveLength(2);
  }, 20_000);

  it("retains one staged output when a failure wins before heartbeat success reconciliation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });
    mockSupportedExecutionProfiles.push("skill_test_output_only");
    heartbeat = heartbeatService(db, {
      testHooks: {
        afterOutputOnlySkillTestOutputStaged: async () => {
          throw new Error("Failure injected after output staging");
        },
      },
    });
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Output retained after failure.",
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
      return run?.status === "failed";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(harness.runId);

    const [run] = await db.select({
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
    expect(run).toEqual({ status: "failed", error: "Failure injected after output staging" });
    const [testRun] = await db.select({
      status: companySkillTestRuns.status,
      error: companySkillTestRuns.error,
      output: companySkillTestRuns.outputSnapshot,
    }).from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    expect(testRun).toEqual({
      status: "failed",
      error: "Failure injected after output staging",
      output: "Output retained after failure.",
    });
    const [issue] = await db.select({ status: issues.status })
      .from(issues).where(eq(issues.id, harness.issueId));
    expect(issue?.status).toBe("done");
    const outputDocuments = await db.select({ body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, harness.issueId));
    expect(outputDocuments).toEqual([{ body: "Output retained after failure." }]);
    expect(await db.select().from(documentRevisions).where(
      eq(documentRevisions.createdByRunId, harness.runId),
    )).toHaveLength(1);
    const auditRows = await db.select({ action: activityLog.action })
      .from(activityLog).where(eq(activityLog.entityId, harness.testRunId));
    expect(auditRows).toEqual(expect.arrayContaining([
      { action: "company.skill_test_output_staged" },
      { action: "company.skill_test_output_failed" },
      { action: "company.skill_test_run_completed" },
    ]));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
  }, 20_000);

  it("terminally fails the exact output-only harness before invoking an unsupported adapter", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
      return run?.status === "failed";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(harness.runId);

    expect(countExecuteCallsForRun(harness.runId)).toBe(0);
    const [run] = await db.select({
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
    expect(run).toEqual({
      status: "failed",
      error: "Adapter codex_local does not support skill_test_output_only.",
      errorCode: "skill_test_output_only_unsupported_adapter",
    });
    const [testRun] = await db.select({
      status: companySkillTestRuns.status,
      error: companySkillTestRuns.error,
    }).from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    expect(testRun).toEqual({ status: "failed", error: run?.error });
    const [issue] = await db.select({ status: issues.status })
      .from(issues).where(eq(issues.id, harness.issueId));
    expect(issue?.status).toBe("done");
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, harness.issueId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
    const auditRows = await db.select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog).where(eq(activityLog.entityId, harness.testRunId));
    expect(auditRows).toEqual(expect.arrayContaining([expect.objectContaining({
      action: "company.skill_test_output_failed",
      details: expect.objectContaining({
        issueId: harness.issueId,
        status: "failed",
        error: run?.error,
        errorCode: run?.errorCode,
      }),
    })]));
  }, 20_000);

  it("terminally reconciles a returned output-only adapter failure without output, retry, or unrelated mutation", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId,
      title: "Unrelated issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    mockSupportedExecutionProfiles.push("skill_test_output_only");
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Codex exited before opening the output window.",
      errorCode: "codex_startup_failed",
      summary: null,
      provider: "test",
      model: "test-model",
    }));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run] = await db.select({ status: heartbeatRuns.status })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
      return run?.status === "failed";
    }, 10_000);
    await heartbeat.waitForRunExecutionDrain(harness.runId);

    const [run] = await db.select({
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
    expect(run).toEqual({
      status: "failed",
      error: "Codex exited before opening the output window.",
      errorCode: "codex_startup_failed",
    });
    const [testRun] = await db.select({
      status: companySkillTestRuns.status,
      error: companySkillTestRuns.error,
      output: companySkillTestRuns.outputSnapshot,
    }).from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    expect(testRun).toEqual({ status: "failed", error: run?.error, output: "" });
    const issueRows = await db.select({ id: issues.id, status: issues.status })
      .from(issues).where(eq(issues.companyId, companyId));
    expect(issueRows).toEqual(expect.arrayContaining([
      { id: harness.issueId, status: "done" },
      { id: unrelatedIssueId, status: "todo" },
    ]));
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, harness.issueId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, harness.issueId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
  }, 20_000);

  it("keeps cancellation authoritative when a late output-only adapter failure returns", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const harness = await seedSkillTestHarness({ companyId, agentId, executionProfile: "output_only" });
    mockSupportedExecutionProfiles.push("skill_test_output_only");
    let releaseAdapter = () => {};
    mockAdapterExecute.mockImplementationOnce(async () => new Promise((resolve) => {
      releaseAdapter = () => resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Late adapter failure",
        errorCode: "late_adapter_failure",
        summary: null,
        provider: "test",
        model: "test-model",
      });
    }));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => countExecuteCallsForRun(harness.runId) === 1, 10_000);
    const cancelledAt = new Date();
    await db.transaction(async (tx) => {
      await tx.update(companySkillTestRuns).set({
        status: "cancelled",
        error: "Cancelled by operator",
        updatedAt: cancelledAt,
      }).where(eq(companySkillTestRuns.id, harness.testRunId));
      await tx.update(issues).set({
        status: "cancelled",
        cancelledAt,
        updatedAt: cancelledAt,
      }).where(eq(issues.id, harness.issueId));
    });
    await heartbeat.cancelRun(harness.runId, "Cancelled by operator");
    releaseAdapter();
    await heartbeat.waitForRunExecutionDrain(harness.runId);

    const [run] = await db.select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, harness.runId));
    expect(run).toEqual({ status: "cancelled", error: "Cancelled by operator" });
    const [testRun] = await db.select({ status: companySkillTestRuns.status, error: companySkillTestRuns.error })
      .from(companySkillTestRuns).where(eq(companySkillTestRuns.id, harness.testRunId));
    expect(testRun).toEqual({ status: "cancelled", error: "Cancelled by operator" });
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, harness.issueId));
    expect(issue?.status).toBe("cancelled");
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, harness.issueId))).toHaveLength(0);
    const failureAudits = await db.select({ action: activityLog.action })
      .from(activityLog).where(eq(activityLog.entityId, harness.testRunId));
    expect(failureAudits.some((row) => row.action === "company.skill_test_output_failed")).toBe(false);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
  }, 20_000);

});
