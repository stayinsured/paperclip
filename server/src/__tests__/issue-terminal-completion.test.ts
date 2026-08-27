import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueTerminalOperations,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTerminalCompletionService } from "../services/issue-terminal-completions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal completion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue terminal completion", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-terminal-completion-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueTerminalOperations);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedExecution(prefix = "ATM") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      issueNumber: 1,
      title: "Atomic terminal completion",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });
    return { companyId, agentId, runId, issueId };
  }

  const operation = {
    status: "done" as const,
    result: "Acceptance rows passed; implementation is ready for review.",
    acceptanceRevision: "acceptance-v1",
    idempotencyKey: "terminal:acceptance-v1",
  };

  it("commits one result and terminal status atomically and replays idempotently", async () => {
    const seeded = await seedExecution();
    const service = issueTerminalCompletionService(db);
    const input = {
      ...seeded,
      operation,
    };

    const first = await service.complete(input);
    const replay = await service.complete(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
    expect(replay.comment.id).toBe(first.comment.id);

    const [savedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    const receipts = await db
      .select()
      .from(issueTerminalOperations)
      .where(eq(issueTerminalOperations.issueId, seeded.issueId));
    expect(savedIssue?.status).toBe("done");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(operation.result);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      resultCommentId: comments[0]?.id,
      acceptanceRevision: operation.acceptanceRevision,
      terminalStatus: "done",
    });

    await expect(service.complete({
      ...input,
      operation: { ...operation, result: "A different result." },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "terminal_idempotency_conflict" },
    });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(1);
    expect(await db.select().from(issueTerminalOperations).where(eq(issueTerminalOperations.issueId, seeded.issueId)))
      .toHaveLength(1);
  });

  it("writes neither row when the run does not own the issue lock", async () => {
    const seeded = await seedExecution("LCK");
    const service = issueTerminalCompletionService(db);

    await expect(service.complete({
      ...seeded,
      runId: randomUUID(),
      operation,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "terminal_run_context_mismatch" },
    });

    const [savedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(savedIssue?.status).toBe("in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(0);
    expect(await db.select().from(issueTerminalOperations).where(eq(issueTerminalOperations.issueId, seeded.issueId)))
      .toHaveLength(0);
  });

  it("returns typed task and company failures without writes", async () => {
    const seeded = await seedExecution("ERR");
    const service = issueTerminalCompletionService(db);

    await expect(service.complete({
      ...seeded,
      issueId: randomUUID(),
      operation,
    })).rejects.toMatchObject({ status: 404, details: { code: "task_not_found" } });
    await expect(service.complete({
      ...seeded,
      companyId: randomUUID(),
      operation,
    })).rejects.toMatchObject({ status: 403, details: { code: "wrong_company" } });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(0);
    expect(await db.select().from(issueTerminalOperations).where(eq(issueTerminalOperations.issueId, seeded.issueId)))
      .toHaveLength(0);
  });

  it("returns typed missing-header, task-not-found, and wrong-company route errors", async () => {
    const seeded = await seedExecution("RTE");
    const appFor = (companyId: string) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = {
          type: "agent",
          source: "agent_key",
          companyId,
          agentId: seeded.agentId,
          runId: seeded.runId,
        };
        next();
      });
      app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
      app.use(errorHandler);
      return app;
    };

    const missingHeader = await request(appFor(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/terminal`)
      .send(operation);
    expect(missingHeader.status).toBe(422);
    expect(missingHeader.body.code).toBe("missing_run_header");

    const missingTask = await request(appFor(seeded.companyId))
      .post(`/api/issues/${randomUUID()}/terminal`)
      .set("X-Paperclip-Run-Id", seeded.runId)
      .send(operation);
    expect(missingTask.status).toBe(404);
    expect(missingTask.body.code).toBe("task_not_found");

    const wrongCompany = await request(appFor(randomUUID()))
      .post(`/api/issues/${seeded.issueId}/terminal`)
      .set("X-Paperclip-Run-Id", seeded.runId)
      .send(operation);
    expect(wrongCompany.status).toBe(403);
    expect(wrongCompany.body.code).toBe("wrong_company");

    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seeded.agentId },
        returnAssignee: { type: "agent", agentId: seeded.agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, seeded.issueId));
    const pendingStage = await request(appFor(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/terminal`)
      .set("X-Paperclip-Run-Id", seeded.runId)
      .send(operation);
    expect(pendingStage.status).toBe(422);
    expect(pendingStage.body.code).toBe("terminal_execution_stage_pending");
    await db.update(issues).set({ executionState: null }).where(eq(issues.id, seeded.issueId));

    const [savedIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(savedIssue?.status).toBe("in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(0);

    const first = await request(appFor(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/terminal`)
      .set("X-Paperclip-Run-Id", seeded.runId)
      .send(operation);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ replayed: false });

    const replay = await request(appFor(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/terminal`)
      .set("X-Paperclip-Run-Id", seeded.runId)
      .send(operation);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      comment: { id: first.body.comment.id },
      terminalOperation: { id: first.body.terminalOperation.id },
    });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toHaveLength(1);
    expect(await db.select().from(issueTerminalOperations).where(eq(issueTerminalOperations.issueId, seeded.issueId)))
      .toHaveLength(1);
  });
});
