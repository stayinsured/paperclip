import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { instanceSettings } from "@paperclipai/db";
import type { PluginExecutionAgentKeyScope } from "@paperclipai/shared";
import { pluginExecutionIngressGuard } from "../middleware/plugin-execution-ingress.js";
import { errorHandler } from "../middleware/error-handler.js";

const scope: PluginExecutionAgentKeyScope = {
  kind: "plugin_execution",
  companyId: "11111111-1111-4111-8111-111111111111",
  pluginId: "22222222-2222-4222-8222-222222222222",
  pluginKey: "paperclip.classifier",
  principalAgentId: "33333333-3333-4333-8333-333333333333",
  attemptId: "44444444-4444-4444-8444-444444444444",
  assessmentId: "assessment-1",
  sourceKind: "issue",
  sourceId: "source-1",
  policyId: "policy-1",
  policyVersion: "1",
  skillId: "55555555-5555-4555-8555-555555555555",
  skillVersionId: "66666666-6666-4666-8666-666666666666",
  skillRevisionNumber: 1,
  skillContentDigest: `sha256:${"a".repeat(64)}`,
  tool: "paperclip.classifier:submit",
  nonceDigest: `sha256:${"b".repeat(64)}`,
  heartbeatRunId: "77777777-7777-4777-8777-777777777777",
  billingCode: "STA-1832/outline-materiality",
  expiresAt: "2026-08-08T12:00:00.000Z",
};

function createAuditDb() {
  const activities: Record<string, unknown>[] = [];
  const settingsRow = {
    id: "88888888-8888-4888-8888-888888888888",
    singletonKey: "default",
    general: {},
    experimental: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const db = {
    select: () => ({
      from(table: unknown) {
        return {
          where() {
            return Promise.resolve(table === instanceSettings ? [settingsRow] : []);
          },
        };
      },
    }),
    insert: () => ({
      values(value: Record<string, unknown>) {
        activities.push(value);
        return {
          returning: () => Promise.resolve([{ id: "99999999-9999-4999-8999-999999999999" }]),
        };
      },
    }),
  } as any;
  return { db, activities };
}

function createApp() {
  const { db, activities } = createAuditDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId: scope.principalAgentId,
      companyId: scope.companyId,
      runId: scope.heartbeatRunId,
      keyScope: scope,
      apiKeyId: null,
      responsibleUserId: null,
    };
    next();
  });
  app.use("/api", pluginExecutionIngressGuard(db));
  app.post("/api/plugin-executions/:attemptId/mcp", (_req, res) => res.json({ ok: true }));
  app.all("/api/{*path}", (_req, res) => res.json({ escaped: true }));
  app.use(errorHandler);
  return { app, activities };
}

describe("plugin execution global ingress", () => {
  it("allows only the exact bound callback endpoint", async () => {
    const { app, activities } = createApp();
    await request(app)
      .post(`/api/plugin-executions/${scope.attemptId}/mcp`)
      .send({ method: "tools/list" })
      .expect(200, { ok: true });
    expect(activities).toHaveLength(0);
  });

  it("denies ordinary auth, issue, agent, secret, runtime, and mismatched callback APIs", async () => {
    const { app, activities } = createApp();
    const denied = [
      ["get", "/api/auth/session"],
      ["get", `/api/companies/${scope.companyId}/issues`],
      ["patch", `/api/companies/${scope.companyId}/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`],
      ["get", `/api/companies/${scope.companyId}/agents`],
      ["get", `/api/companies/${scope.companyId}/secrets`],
      ["get", `/api/heartbeat-runs/${scope.heartbeatRunId}`],
      ["post", "/api/plugin-executions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp"],
      ["get", `/api/plugin-executions/${scope.attemptId}/mcp`],
    ] as const;
    for (const [method, path] of denied) {
      const response = await request(app)[method](path).send({});
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
      expect(response.body.error).toContain("cannot access ordinary Paperclip APIs");
    }
    expect(activities).toHaveLength(denied.length);
    expect(activities.every((activity) => activity.action === "plugin_execution.ingress_denied")).toBe(true);
  });
});
