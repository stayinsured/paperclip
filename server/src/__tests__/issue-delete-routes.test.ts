import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  feedbackVotes,
  financeEvents,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  issueThreadInteractions,
  principalPermissionGrants,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue delete routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-delete-routes-", {
    resetEach: async (db) => {
      await db.delete(financeEvents);
      await db.delete(costEvents);
      await db.delete(activityLog);
      await db.delete(feedbackVotes);
      await db.delete(issueThreadInteractions);
      await db.delete(issueComments);
      await db.delete(issueInboxArchives);
      await db.delete(issueReadStates);
      await db.delete(issues);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(agents);
      await db.delete(companies);
    },
  });

  it("deletes issue-owned state while preserving accounting history", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Issue delete");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Issue delete agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const [issue] = await ctx.db.insert(issues).values({
      companyId,
      title: "Disposable issue",
      status: "cancelled",
      priority: "low",
      assigneeAgentId: agentId,
    }).returning();

    await ctx.db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorUserId: userId,
      body: "Disposable evidence",
    });
    await ctx.db.insert(issueInboxArchives).values({ companyId, issueId: issue.id, userId });
    await ctx.db.insert(issueReadStates).values({ companyId, issueId: issue.id, userId });
    await ctx.db.insert(issueThreadInteractions).values({
      companyId,
      issueId: issue.id,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, questions: [] },
    });
    await ctx.db.insert(feedbackVotes).values({
      companyId,
      issueId: issue.id,
      targetType: "issue",
      targetId: issue.id,
      authorUserId: userId,
      vote: "up",
    });

    const [costEvent] = await ctx.db.insert(costEvents).values({
      companyId,
      agentId,
      issueId: issue.id,
      provider: "test-provider",
      biller: "test-biller",
      billingType: "tokens",
      costStatus: "reported",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    }).returning();
    const [financeEvent] = await ctx.db.insert(financeEvents).values({
      companyId,
      agentId,
      issueId: issue.id,
      eventKind: "model_inference",
      direction: "debit",
      biller: "test-biller",
      amountCents: 1,
      occurredAt: new Date(),
    }).returning();

    const app = routeApp(ctx.db, actor, issueRoutes);
    await request(app).delete(`/api/issues/${issue.id}`).expect(200);
    await request(app).get(`/api/issues/${issue.id}`).expect(404);

    await expect(ctx.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).resolves.toEqual([]);
    await expect(ctx.db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, issue.id))).resolves.toEqual([]);
    await expect(ctx.db.select().from(issueReadStates).where(eq(issueReadStates.issueId, issue.id))).resolves.toEqual([]);
    await expect(ctx.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id))).resolves.toEqual([]);
    await expect(ctx.db.select().from(feedbackVotes).where(eq(feedbackVotes.issueId, issue.id))).resolves.toEqual([]);

    await expect(ctx.db.select({ issueId: costEvents.issueId }).from(costEvents).where(eq(costEvents.id, costEvent.id)))
      .resolves.toEqual([{ issueId: null }]);
    await expect(ctx.db.select({ issueId: financeEvents.issueId }).from(financeEvents).where(eq(financeEvents.id, financeEvent.id)))
      .resolves.toEqual([{ issueId: null }]);
  });
});
