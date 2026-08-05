import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import releaseGraph from "./fixtures/synthetic-release-six-item-graph.json" with { type: "json" };
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres work-product handoff route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("atomic work-product release handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-product-handoff-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists one owner handoff under concurrent completion while attempts remain inside six issues", async () => {
    expect(releaseGraph.items).toHaveLength(releaseGraph.maxDurableItems);
    expect(new Set(releaseGraph.items.map((item) => item.key)).size).toBe(releaseGraph.items.length);

    const companyId = randomUUID();
    const implementationAgentId = randomUUID();
    const qaAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic release company",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: implementationAgentId,
        companyId,
        name: "Implementation Owner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Owner",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const issueIdByKey = new Map(releaseGraph.items.map((item) => [item.key, randomUUID()]));
    await db.insert(issues).values(releaseGraph.items.map((item) => ({
      id: issueIdByKey.get(item.key)!,
      companyId,
      parentId: item.parentKey ? issueIdByKey.get(item.parentKey)! : null,
      title: item.title,
      status: "todo",
      priority: "high",
      assigneeAgentId: item.key === "qualification" ? qaAgentId : implementationAgentId,
    })));

    await db.insert(activityLog).values(releaseGraph.nonIssueAttempts.map((attempt) => ({
      companyId,
      actorType: "system",
      actorId: "synthetic_release_fixture",
      action: attempt.action,
      entityType: "issue",
      entityId: issueIdByKey.get(attempt.sourceItemKey)!,
      details: { attemptKey: attempt.key, representation: "event" },
    })));

    const workProductId = randomUUID();
    const sourceIssueId = issueIdByKey.get(releaseGraph.handoff.sourceItemKey)!;
    const targetIssueId = issueIdByKey.get(releaseGraph.handoff.targetItemKey)!;
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId: sourceIssueId,
      type: "artifact",
      provider: "synthetic",
      title: "Fast-gate evidence",
      status: "active",
      metadata: {
        handoff: {
          transitionKey: releaseGraph.handoff.transitionKey,
          nextOwnerAgentId: qaAgentId,
          targetIssueId,
          summary: "Synthetic gate completed without provider mutation.",
        },
      },
    });

    const wakeWrites: Promise<unknown>[] = [];
    const enqueueWakeup = vi.fn((agentId: string, options: { reason?: string | null; idempotencyKey?: string | null }) => {
      const write = (async () => {
        await db.insert(agentWakeupRequests).values({
          companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: options.reason ?? null,
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: "work_product_handoff",
          idempotencyKey: options.idempotencyKey ?? null,
        });
        return null;
      })();
      wakeWrites.push(write);
      return write;
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "release-fixture-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {
      workProductHandoffEnqueueWakeup: enqueueWakeup,
    }));
    app.use(errorHandler);

    const completions = await Promise.all([
      request(app).patch(`/api/work-products/${workProductId}`).send({ status: "ready_for_review" }),
      request(app).patch(`/api/work-products/${workProductId}`).send({ status: "ready_for_review" }),
    ]);
    expect(completions.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(wakeWrites);

    const handoffActivities = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.work_product_handoff_emitted"),
      eq(activityLog.entityId, targetIssueId),
    ));
    const handoffComments = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, targetIssueId),
      eq(issueComments.authorType, "system"),
    ));
    const handoffWakeups = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, qaAgentId),
      eq(agentWakeupRequests.reason, "work_product_handoff"),
    ));
    const durableIssues = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const attemptEvents = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.actorId, "synthetic_release_fixture"),
    ));

    expect(handoffActivities).toHaveLength(1);
    expect(handoffComments).toHaveLength(1);
    expect(handoffWakeups).toHaveLength(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      qaAgentId,
      expect.objectContaining({
        reason: "work_product_handoff",
        idempotencyKey: `work_product_handoff:${targetIssueId}:${releaseGraph.handoff.transitionKey}`,
      }),
    );
    expect(durableIssues).toHaveLength(releaseGraph.maxDurableItems);
    expect(durableIssues.filter((issue) => issue.originKind?.includes("recovery"))).toHaveLength(0);
    expect(attemptEvents).toHaveLength(releaseGraph.nonIssueAttempts.length);
  });
});
