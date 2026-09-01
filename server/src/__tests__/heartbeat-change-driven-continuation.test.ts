import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { SDLC_EVIDENCE_DOCUMENT_KEY } from "../services/sdlc-lifecycle.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Change-driven continuation test run.",
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
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres change-driven continuation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("change-driven issue continuation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-change-driven-continuation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedAgentIssue(title: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Continuation ${title}`,
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Continuation Agent",
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function waitForRun(runId: string) {
    await heartbeat.waitForRunExecutionDrain(runId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (run?.status === "succeeded") return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Run ${runId} did not reach succeeded`);
  }

  // Successful runs asynchronously trigger the pre-existing successful-run handoff
  // corrective wake. Let that machinery settle before asserting or waking again, so
  // a new change-driven wake meets an idle agent (no coalescing) deterministically.
  async function waitForAgentIdle(agentId: string) {
    const deadline = Date.now() + 15_000;
    let stable = 0;
    while (Date.now() < deadline) {
      const [busyRuns, pendingWakes] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.agentId, agentId),
            inArray(heartbeatRuns.status, ["queued", "running", "pending"]),
          ))
          .then((rows) => rows[0]?.count ?? 0),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.agentId, agentId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
          ))
          .then((rows) => rows[0]?.count ?? 0),
      ]);
      if (busyRuns === 0 && pendingWakes === 0) {
        stable += 1;
        if (stable >= 3) return;
      } else {
        stable = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Agent ${agentId} did not reach quiescence`);
  }

  // Successful runs on in_progress issues asynchronously trigger the pre-existing
  // finish_successful_run_handoff corrective run (no continuation key, out of scope
  // for change-driven suppression — its lifecycle must be preserved). Exclude it so
  // the counts below assert only the change-driven continuation paths under test.
  const issueRunFilter = (issueId: string) => sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}
    AND COALESCE(${heartbeatRuns.contextSnapshot} ->> 'wakeReason', '') <> 'finish_successful_run_handoff'`;

  async function counts(issueId: string) {
    const [runCount, commentCount, wakeCount] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(issueRunFilter(issueId))
        .then((rows) => rows[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, issueId),
          sql`coalesce(${issueComments.authorType}, 'user') <> 'system'`,
        ))
        .then((rows) => rows[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentWakeupRequests)
        .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}
          AND coalesce(${agentWakeupRequests.reason}, '') <> 'finish_successful_run_handoff'`)
        .then((rows) => rows[0]?.count ?? 0),
    ]);
    return { runCount, commentCount, wakeCount };
  }

  it("creates no new run or comment when an unchanged pending interaction wake is replayed", async () => {
    const { companyId, agentId, issueId } = await seedAgentIssue("Pending interaction replay");
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: agentId,
      payload: {
        prompt: "Approve the continuation?",
        target: { type: "issue", issueId },
      },
    });
    const options = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "interaction_pending",
      payload: {
        issueId,
        interactionId,
        interactionKind: "request_confirmation",
        mutation: "interaction",
      },
      idempotencyKey: `interaction-pending:${interactionId}`,
      changeDrivenContinuation: true,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        interactionId,
        interactionKind: "request_confirmation",
        wakeReason: "interaction_pending",
        source: "issue.interaction.created",
      },
    };

    const first = await heartbeat.wakeup(agentId, options);
    expect(first).not.toBeNull();
    await waitForRun(first!.id);
    await waitForAgentIdle(agentId);
    const beforeReplay = await counts(issueId);

    const replay = await heartbeat.wakeup(agentId, options);
    expect(replay).toBeNull();
    const afterReplay = await counts(issueId);

    expect(afterReplay.runCount).toBe(beforeReplay.runCount);
    expect(afterReplay.commentCount).toBe(beforeReplay.commentCount);
    expect(afterReplay.wakeCount).toBe(beforeReplay.wakeCount);
  });

  it("creates no new run or comment when an unchanged deterministic blocker guard is replayed", async () => {
    const { companyId, agentId, issueId } = await seedAgentIssue("Guard rejection replay");
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Open prerequisite",
      status: "in_progress",
      responsibleUserId: "responsible-user",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const options = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_blockers_resolved",
      payload: { issueId, resolvedBlockerIssueId: blockerId },
      changeDrivenContinuation: true,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_blockers_resolved",
      },
    };

    expect(await heartbeat.wakeup(agentId, options)).toBeNull();
    const beforeReplay = await counts(issueId);
    expect(await heartbeat.wakeup(agentId, options)).toBeNull();
    const afterReplay = await counts(issueId);

    expect(afterReplay.runCount).toBe(0);
    expect(afterReplay.commentCount).toBe(0);
    expect(afterReplay.runCount).toBe(beforeReplay.runCount);
    expect(afterReplay.commentCount).toBe(beforeReplay.commentCount);
  });

  it("wakes exactly once for each evidence document revision", async () => {
    const { companyId, agentId, issueId } = await seedAgentIssue("Evidence revision");
    const documentId = randomUUID();
    const firstRevisionId = randomUUID();
    const classification = JSON.stringify({
      id: randomUUID(),
      type: "classification",
      class: "C2",
      companyId,
      issueId,
      createdAt: new Date().toISOString(),
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "SDLC evidence",
      latestBody: `${classification}\n`,
      latestRevisionId: firstRevisionId,
      latestRevisionNumber: 1,
      createdByUserId: "board-user",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: SDLC_EVIDENCE_DOCUMENT_KEY,
    });
    const wake = () => heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "sdlc_evidence_revised",
      payload: { issueId, documentId },
      changeDrivenContinuation: true,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "sdlc_evidence_revised",
      },
    });

    const first = await wake();
    expect(first).not.toBeNull();
    await waitForRun(first!.id);
    await waitForAgentIdle(agentId);
    expect(await wake()).toBeNull();
    expect((await counts(issueId)).runCount).toBe(1);

    const secondRevisionId = randomUUID();
    await db
      .update(documents)
      .set({
        latestRevisionId: secondRevisionId,
        latestRevisionNumber: 2,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)));

    const second = await wake();
    expect(second).not.toBeNull();
    expect(await wake()).toBeNull();
    await waitForRun(second!.id);
    await waitForAgentIdle(agentId);

    const beforeFinalReplay = await counts(issueId);
    expect(beforeFinalReplay.runCount).toBe(2);
    expect(await wake()).toBeNull();
    const afterFinalReplay = await counts(issueId);
    expect(afterFinalReplay.runCount).toBe(beforeFinalReplay.runCount);
    expect(afterFinalReplay.commentCount).toBe(beforeFinalReplay.commentCount);

    const continuationKeys = await db
      .select({ continuationKey: agentWakeupRequests.continuationKey })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
      ));
    expect(
      new Set(
        continuationKeys
          .map((row) => row.continuationKey)
          .filter((key): key is string => key !== null),
      ).size,
    ).toBe(2);
  });
});
