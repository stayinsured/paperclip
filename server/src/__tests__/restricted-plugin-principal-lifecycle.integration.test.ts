import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySkills,
  companySkillVersions,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  pluginExecutionAttempts,
  plugins,
} from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { PaperclipPluginManifestV1, PluginExecutionAgentKeyScope } from "@paperclipai/shared";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginExecutionIngressGuard } from "../middleware/plugin-execution-ingress.js";
import { pluginExecutionRoutes } from "../routes/plugin-executions.js";
import { companySkillService } from "../services/company-skills.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  PLUGIN_EXECUTION_CALLBACK_MS,
  PLUGIN_EXECUTION_RUNTIME_MS,
  pluginExecutionAttemptService,
} from "../services/plugin-execution-attempts.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const INSTANCE_ID = "sta-2166-restricted-principal";
const PLUGIN_ID = "21660000-0000-4000-8000-000000000001";
const PLUGIN_KEY = "paperclip.sta-2166-restricted-principal";
const COMPANY_ID = "21660000-0000-4000-8000-000000000002";
const OTHER_COMPANY_ID = "21660000-0000-4000-8000-000000000003";
const OTHER_AGENT_ID = "21660000-0000-4000-8000-000000000004";
const OTHER_COMPANY_AGENT_ID = "21660000-0000-4000-8000-000000000005";
const SOURCE_ISSUE_ID = "21660000-0000-4000-8000-000000000006";
const BILLING_CODE = "STA-1832/outline-materiality";
const TEST_JWT_SECRET = "sta-2166-isolated-jwt-secret-not-a-provider-credential";
const CALLBACK_TOOL = `${PLUGIN_KEY}:record-materiality`;

type Db = ReturnType<typeof createDb>;
type Scenario = {
  result: AdapterExecutionResult;
  run(ctx: AdapterExecutionContext): Promise<void>;
};

type SanitizedEvidence = {
  schemaVersion: 1;
  repository: { branch: string; sha: string };
  fixture: {
    instanceId: string;
    database: { kind: "embedded-postgres"; databaseName: "paperclip"; endpointDigest: string };
    adapter: "fake-codex-local";
    providerCalls: 0;
    initialRowCounts: { companies: number; plugins: number; attempts: number };
  };
  window: { startedAt: string; finishedAt?: string };
  restartBoundary?: {
    before: "service-boot-1";
    after: "service-boot-2";
    sameDatabase: true;
  };
  inventory?: {
    pinnedSkillSnapshots: 1;
    pinnedSkillFiles: 1;
    callbackMcpServers: 1;
    namespacedCallbackTools: [string];
    ordinaryRuntimeSkills: 0;
  };
  cases?: Record<string, string>;
  durableRows?: {
    attempts: Array<Record<string, unknown>>;
    heartbeats: Array<Record<string, unknown>>;
    activities: Array<Record<string, unknown>>;
    costs: Array<Record<string, unknown>>;
  };
  plaintextTokenPersisted?: false;
  cleanup?: { databaseStopped: true; tempHomeRemoved: true };
};

function restrictedManifest(): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "STA-2166 Restricted Principal Fixture",
    description: "Non-production lifecycle evidence fixture",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agents.managed", "skills.managed", "agent.tools.register"],
    entrypoints: { worker: "./dist/worker.js" },
    tools: [{
      name: "record-materiality",
      displayName: "Record materiality",
      description: "Record one bounded non-production materiality result",
      parametersSchema: {
        type: "object",
        properties: {
          sourceIssueId: { type: "string" },
          material: { type: "boolean" },
          summary: { type: "string", maxLength: 200 },
        },
        required: ["sourceIssueId", "material", "summary"],
        additionalProperties: false,
      },
    }],
    skills: [{
      skillKey: "materiality",
      displayName: "Materiality classifier",
      files: [{ path: "SKILL.md", content: "# Materiality classifier\n\nUse only the sanitized envelope." }],
    }],
    agents: [{
      agentKey: "materiality-classifier",
      displayName: "Materiality classifier",
      adapterType: "codex_local",
      executionPrincipal: {
        kind: "plugin_tool_only",
        skillKey: "materiality",
        tool: CALLBACK_TOOL,
      },
    }],
  };
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: async () => {}, subscribe: () => {}, clear: () => {} };
    },
  } as any;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function repoValue(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function makeWorkerManager() {
  const calls: Array<{ pluginId: string; toolName: string; runId: string }> = [];
  let implementation = async (pluginId: string, params: any) => {
    calls.push({ pluginId, toolName: params.toolName, runId: params.runContext.runId });
    return { content: "recorded", data: { recorded: true, revision: "fixture-1" } };
  };
  const manager: PluginWorkerManager = {
    startWorker: async () => { throw new Error("The evidence fixture never starts a plugin worker"); },
    stopWorker: async () => {},
    getWorker: () => undefined,
    isRunning: (pluginId) => pluginId === PLUGIN_ID,
    setProactiveCompanyScopes: () => {},
    stopAll: async () => {},
    diagnostics: () => [],
    call: async (pluginId, method, params) => {
      if (method !== "executeTool") throw new Error(`Unexpected fake worker method: ${method}`);
      return await implementation(pluginId, params) as any;
    },
  };
  return {
    manager,
    calls,
    setImplementation(next: typeof implementation) {
      implementation = next;
    },
    resetImplementation() {
      implementation = async (pluginId: string, params: any) => {
        calls.push({ pluginId, toolName: params.toolName, runId: params.runContext.runId });
        return { content: "recorded", data: { recorded: true, revision: "fixture-1" } };
      };
    },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port");
  return address.port;
}

async function close(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startHttpService(db: Db, workerManager: PluginWorkerManager) {
  const dispatcher = createPluginToolDispatcher({ db, workerManager });
  await dispatcher.initialize();
  const app = express();
  app.locals.paperclipDb = db;
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  app.use("/api", pluginExecutionIngressGuard(db));
  app.use("/api", pluginExecutionRoutes(db, dispatcher));
  app.all("/api/{*path}", (_req, res) => res.json({ escapedRestrictedIngress: true }));
  app.use(errorHandler);
  const server = createServer(app);
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dispatcher,
    server,
    async stop() {
      await close(server);
      dispatcher.teardown();
    },
  };
}

async function rpc(
  baseUrl: string,
  token: string,
  attemptId: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}/api/plugin-executions/${attemptId}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${attemptId}`, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ordinaryApi(baseUrl: string, token: string, method: string, url: string) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitForTerminal(db: Db, runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (row && !["queued", "running"].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

function scopeFromToken(token: string): PluginExecutionAgentKeyScope {
  const scope = verifyLocalAgentJwt(token)?.key_scope;
  if (!scope || scope.kind !== "plugin_execution") throw new Error("Expected a restricted plugin execution scope");
  return scope;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping restricted principal lifecycle integration evidence: ${embeddedPostgresSupport.reason ?? "embedded PostgreSQL unavailable"}`,
  );
}

describeEmbeddedPostgres("restricted plugin principal exact-SHA lifecycle evidence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let httpService: Awaited<ReturnType<typeof startHttpService>> | null = null;
  let restartedHttpService: Awaited<ReturnType<typeof startHttpService>> | null = null;
  let tempHome: string | null = null;
  let evidence: SanitizedEvidence | null = null;
  const manifest = restrictedManifest();
  const worker = makeWorkerManager();
  const scenarios: Scenario[] = [];
  const capturedTokens: string[] = [];
  let adapterCalls = 0;
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of [
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK",
      "PAPERCLIP_INSTANCE_ID",
      "PAPERCLIP_HOME",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_IN_WORKTREE",
      "PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS",
      "PAPERCLIP_RESTORE_IN_PROGRESS",
    ]) previousEnv.set(key, process.env[key]);

    process.env.PAPERCLIP_AGENT_JWT_SECRET = TEST_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
    process.env.PAPERCLIP_INSTANCE_ID = INSTANCE_ID;
    delete process.env.PAPERCLIP_IN_WORKTREE;
    delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    delete process.env.PAPERCLIP_RESTORE_IN_PROGRESS;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sta-2166-home-"));
    process.env.PAPERCLIP_HOME = tempHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sta-2166-db-");
    db = createDb(tempDb.connectionString);
    evidence = {
      schemaVersion: 1,
      repository: { branch: repoValue(["branch", "--show-current"]), sha: repoValue(["rev-parse", "HEAD"]) },
      fixture: {
        instanceId: INSTANCE_ID,
        database: { kind: "embedded-postgres", databaseName: "paperclip", endpointDigest: digest(tempDb.connectionString) },
        adapter: "fake-codex-local",
        providerCalls: 0,
        initialRowCounts: {
          companies: (await db.select().from(companies)).length,
          plugins: (await db.select().from(plugins)).length,
          attempts: (await db.select().from(pluginExecutionAttempts)).length,
        },
      },
      window: { startedAt: new Date().toISOString() },
    };

    registerServerAdapter({
      type: "codex_local",
      supportedExecutionProfiles: ["skill_test_output_only", "skill_test_response_only", "plugin_execution_tool_only"],
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
      execute: async (ctx) => {
        adapterCalls += 1;
        const scenario = scenarios.shift();
        if (!scenario) throw new Error(`Unexpected restricted adapter call for run ${ctx.runId}`);
        await scenario.run(ctx);
        return scenario.result;
      },
    });
  }, 30_000);

  afterAll(async () => {
    unregisterServerAdapter("codex_local");
    await restartedHttpService?.stop();
    await httpService?.stop();
    await tempDb?.cleanup();
    if (tempHome) await fs.rm(tempHome, { recursive: true, force: true });
    if (evidence) {
      evidence.window.finishedAt = new Date().toISOString();
      evidence.cleanup = { databaseStopped: true, tempHomeRemoved: true };
      const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
      expect(serialized).not.toContain(TEST_JWT_SECRET);
      expect(capturedTokens.every((token) => !serialized.includes(token))).toBe(true);
      const outputPath = process.env.PAPERCLIP_TEST_EVIDENCE_PATH?.trim();
      if (outputPath) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, serialized, "utf8");
      }
      console.info(`STA2166_EVIDENCE ${JSON.stringify(evidence)}`);
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("proves admission, HTTP containment, pin/race semantics, and restart durability", async () => {
    expect(evidence?.fixture.initialRowCounts).toEqual({ companies: 0, plugins: 0, attempts: 0 });

    await db.insert(companies).values([
      { id: COMPANY_ID, name: "STA-2166 Fixture", issuePrefix: "S2166", defaultResponsibleUserId: "fixture-user" },
      { id: OTHER_COMPANY_ID, name: "STA-2166 Other", issuePrefix: "O2166", defaultResponsibleUserId: "fixture-user" },
    ]);
    await db.insert(plugins).values({
      id: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      packageName: "@paperclipai/sta-2166-restricted-principal-fixture",
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
    });
    await db.insert(agents).values([
      {
        id: OTHER_AGENT_ID,
        companyId: COMPANY_ID,
        name: "Unrelated same-company agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: OTHER_COMPANY_AGENT_ID,
        companyId: OTHER_COMPANY_ID,
        name: "Unrelated cross-company agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const completedAt = new Date("2026-08-12T00:00:00.000Z");
    await db.insert(issues).values({
      id: SOURCE_ISSUE_ID,
      companyId: COMPANY_ID,
      title: "Completed immutable source",
      description: "The restricted lifecycle may assess but never mutate this issue.",
      identifier: "S2166-1",
      issueNumber: 1,
      status: "done",
      priority: "high",
      completedAt,
    });
    const sourceBefore = await db.select().from(issues).where(eq(issues.id, SOURCE_ISSUE_ID)).then((rows) => rows[0]!);

    httpService = await startHttpService(db, worker.manager);
    process.env.PAPERCLIP_API_URL = `${httpService.baseUrl}/api`;
    expect(httpService.dispatcher.listToolsForAgent().map((tool) => tool.name)).toEqual([CALLBACK_TOOL]);

    const services = buildHostServices(db, PLUGIN_ID, PLUGIN_KEY, createEventBusStub(), undefined, {
      manifest,
      pluginWorkerManager: worker.manager,
    });
    const principal = await services.agents.managedReconcile({ companyId: COMPANY_ID, agentKey: "materiality-classifier" });
    const skill = await services.skills.managedReconcile({ companyId: COMPANY_ID, skillKey: "materiality" });
    expect(principal.agentId).toBeTruthy();
    expect(skill.skillId).toBeTruthy();
    if (!principal.agentId || !skill.skillId) throw new Error("Fixture failed to reconcile its managed resources");
    const reconciledSkill = await db.select().from(companySkills)
      .where(eq(companySkills.id, skill.skillId))
      .then((rows) => rows[0]!);
    if (!reconciledSkill.currentVersionId) {
      await companySkillService(db).createVersion(COMPANY_ID, skill.skillId, { label: "Restricted execution pin" }, null);
    }
    const pinnedSkill = await db.select().from(companySkills).where(eq(companySkills.id, skill.skillId)).then((rows) => rows[0]!);
    const pinnedVersion = await db.select().from(companySkillVersions).where(eq(companySkillVersions.id, pinnedSkill.currentVersionId!)).then((rows) => rows[0]!);

    const makeInvocation = (coordinatorAttemptId: string) => ({
      companyId: COMPANY_ID,
      principalAgentKey: "materiality-classifier",
      coordinatorAttemptId,
      assessmentId: `assessment-${coordinatorAttemptId}`,
      source: { kind: "issue", id: SOURCE_ISSUE_ID },
      policy: { id: "outline-materiality", version: "1" },
      nonce: `nonce-${coordinatorAttemptId}`,
      billingCode: BILLING_CODE,
      envelope: { title: "Completed immutable source", outcome: "sanitized fixture" },
    });

    const goldenRunIds: string[] = [];
    const goldenAttemptIds: string[] = [];
    let firstInventory: SanitizedEvidence["inventory"] | undefined;
    const runGolden = async (
      name: string,
      result: AdapterExecutionResult,
      includeNegativeMatrix = false,
    ) => {
      scenarios.push({
        result,
        run: async (ctx) => {
          expect(ctx.executionProfile?.kind).toBe("plugin_execution_tool_only");
          if (ctx.executionProfile?.kind !== "plugin_execution_tool_only") throw new Error("Missing restricted execution profile");
          const servers = ctx.runtimeMcp?.getServers() ?? [];
          expect(servers).toHaveLength(1);
          expect(servers[0]?.name).toBe("plugin_execution_callback");
          expect(ctx.executionProfile.skillSnapshot.files).toHaveLength(1);
          expect(ctx.executionProfile.skillSnapshot.files[0]).toMatchObject({ path: "SKILL.md" });
          expect(ctx.config).toMatchObject({
            timeoutSec: PLUGIN_EXECUTION_RUNTIME_MS / 1000,
            search: false,
            dangerouslyBypassApprovalsAndSandbox: false,
            dangerouslyBypassSandbox: false,
            args: [],
            extraArgs: [],
            paperclipRuntimeSkills: [],
          });
          const runtimeEnv = (ctx.config.env ?? {}) as Record<string, unknown>;
          expect(runtimeEnv.OPENAI_API_KEY).toBeUndefined();
          expect(runtimeEnv.ANTHROPIC_API_KEY).toBeUndefined();
          expect(runtimeEnv.OUTLINE_API_KEY).toBeUndefined();
          firstInventory ??= {
            pinnedSkillSnapshots: 1,
            pinnedSkillFiles: 1,
            callbackMcpServers: 1,
            namespacedCallbackTools: [CALLBACK_TOOL],
            ordinaryRuntimeSkills: 0,
          };
          const server = servers[0]!;
          capturedTokens.push(server.token);
          const scope = scopeFromToken(server.token);
          expect(scope.attemptId).toBe(ctx.executionProfile.attemptId);
          expect(scope.skillId).toBe(ctx.executionProfile.skillId);
          expect(scope.skillVersionId).toBe(ctx.executionProfile.skillVersionId);
          expect(scope.skillContentDigest).toBe(ctx.executionProfile.skillContentDigest);
          expect(scope.tool).toBe(CALLBACK_TOOL);
          const attempt = await db.select().from(pluginExecutionAttempts).where(eq(pluginExecutionAttempts.id, scope.attemptId)).then((rows) => rows[0]!);
          expect(attempt.startedAt).not.toBeNull();
          expect(attempt.runtimeExpiresAt.getTime() - attempt.startedAt!.getTime()).toBe(PLUGIN_EXECUTION_RUNTIME_MS);
          expect(attempt.callbackExpiresAt.getTime() - attempt.startedAt!.getTime()).toBe(PLUGIN_EXECUTION_CALLBACK_MS);

          const initialized = await rpc(httpService!.baseUrl, server.token, scope.attemptId, "initialize");
          expect(initialized.status).toBe(200);
          const listed = await rpc(httpService!.baseUrl, server.token, scope.attemptId, "tools/list");
          expect(listed.status).toBe(200);
          expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([CALLBACK_TOOL]);

          if (includeNegativeMatrix) {
            const ordinaryPaths = [
              ["GET", "/api/auth/session"],
              ["GET", `/api/companies/${COMPANY_ID}`],
              ["GET", `/api/companies/${COMPANY_ID}/issues`],
              ["POST", `/api/companies/${COMPANY_ID}/issues`],
              ["PATCH", `/api/issues/${SOURCE_ISSUE_ID}`],
              ["POST", `/api/issues/${SOURCE_ISSUE_ID}/comments`],
              ["GET", `/api/companies/${COMPANY_ID}/agents`],
              ["GET", `/api/companies/${COMPANY_ID}/projects`],
              ["GET", `/api/companies/${COMPANY_ID}/secrets`],
              ["GET", `/api/heartbeat-runs/${scope.heartbeatRunId}`],
              ["POST", `/api/agents/${principal.agentId}/wakeup`],
              ["POST", `/api/agents/${principal.agentId}/invoke`],
            ] as const;
            for (const [method, url] of ordinaryPaths) {
              const denied = await ordinaryApi(httpService!.baseUrl, server.token, method, url);
              expect(denied.status, `${method} ${url}`).toBe(403);
              expect(denied.body.code).toBe("plugin_execution_ingress_denied");
            }

            const claimCases: Array<{
              name: string;
              subject: string;
              companyId: string;
              runId: string;
              scope: PluginExecutionAgentKeyScope;
              attemptId?: string;
            }> = [
              { name: "cross-company", subject: OTHER_COMPANY_AGENT_ID, companyId: OTHER_COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, companyId: OTHER_COMPANY_ID, principalAgentId: OTHER_COMPANY_AGENT_ID } },
              { name: "cross-principal", subject: OTHER_AGENT_ID, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, principalAgentId: OTHER_AGENT_ID } },
              { name: "cross-run", subject: principal.agentId!, companyId: COMPANY_ID, runId: randomUUID(), scope: { ...scope, heartbeatRunId: randomUUID() } },
              { name: "cross-attempt", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope }, attemptId: randomUUID() },
              { name: "wrong-attempt", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, attemptId: randomUUID() } },
              { name: "wrong-assessment", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, assessmentId: "wrong-assessment" } },
              { name: "wrong-source", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, sourceId: randomUUID() } },
              { name: "wrong-policy", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, policyVersion: "wrong-policy" } },
              { name: "wrong-nonce", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, nonceDigest: digest("wrong-nonce") } },
              { name: "wrong-tool-claim", subject: principal.agentId!, companyId: COMPANY_ID, runId: scope.heartbeatRunId, scope: { ...scope, tool: `${PLUGIN_KEY}:other-tool` } },
            ];
            for (const claimCase of claimCases) {
              if (claimCase.name === "cross-run") claimCase.scope.heartbeatRunId = claimCase.runId;
              const token = createLocalAgentJwt(
                claimCase.subject,
                claimCase.companyId,
                "codex_local",
                claimCase.runId,
                null,
                claimCase.scope,
              );
              if (!token) throw new Error(`Could not mint ${claimCase.name} fixture token`);
              const denied = await rpc(
                httpService!.baseUrl,
                token,
                claimCase.attemptId ?? claimCase.scope.attemptId,
                "tools/list",
              );
              expect(denied.status, claimCase.name).toBe(403);
            }
            const beforeWrongTool = worker.calls.length;
            const wrongTool = await rpc(httpService!.baseUrl, server.token, scope.attemptId, "tools/call", {
              name: `${PLUGIN_KEY}:other-tool`,
              arguments: {},
            });
            expect(wrongTool.status).toBe(403);
            expect(worker.calls).toHaveLength(beforeWrongTool);
          }

          const callback = await rpc(httpService!.baseUrl, server.token, scope.attemptId, "tools/call", {
            name: CALLBACK_TOOL,
            arguments: { sourceIssueId: SOURCE_ISSUE_ID, material: true, summary: `bounded ${name}` },
          });
          expect(callback.status).toBe(200);
          expect(callback.body.result.structuredContent).toEqual({ recorded: true, revision: "fixture-1" });
        },
      });
      const invoked = await services.agents.executionInvoke(makeInvocation(`golden-${name}`));
      expect(invoked.heartbeatRunId).toBeTruthy();
      goldenAttemptIds.push(invoked.id);
      goldenRunIds.push(invoked.heartbeatRunId!);
      const run = await waitForTerminal(db, invoked.heartbeatRunId!);
      expect(run?.status).toBe("succeeded");
      const attempt = await db.select().from(pluginExecutionAttempts).where(eq(pluginExecutionAttempts.id, invoked.id)).then((rows) => rows[0]!);
      expect(attempt.status).toBe("succeeded");
      expect(attempt.billingCode).toBe(BILLING_CODE);
      return { attempt, run: run! };
    };

    const priced = await runGolden("priced", {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "fake-local",
      biller: "fixture-meter",
      model: "fixture-model",
      billingType: "metered_api",
      usageBasis: "per_run",
      usage: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 7 },
      costUsd: 0.12,
      summary: "priced fixture complete",
    }, true);
    const subscription = await runGolden("subscription", {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "fake-local",
      biller: "fixture-subscription",
      model: "fixture-model",
      billingType: "subscription_included",
      usageBasis: "per_run",
      usage: { inputTokens: 13, cachedInputTokens: 5, outputTokens: 8 },
      costUsd: 0,
      summary: "subscription fixture complete",
    });
    const unpriced = await runGolden("unpriced", {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "fake-local",
      biller: "fixture-unknown",
      model: "fixture-model",
      billingType: "unknown",
      usageBasis: "per_run",
      usage: { inputTokens: 17, cachedInputTokens: 2, outputTokens: 9 },
      summary: "unpriced fixture complete",
    });
    await heartbeatService(db).drainActiveRunExecutions();
    expect(adapterCalls).toBe(3);
    expect(firstInventory).toBeDefined();
    evidence!.inventory = firstInventory;

    const attempts = pluginExecutionAttemptService(db);
    const owner = { pluginId: PLUGIN_ID, pluginKey: PLUGIN_KEY, manifest };
    let manualIndex = 0;
    const manuallyStart = async (label: string) => {
      manualIndex += 1;
      const row = await attempts.invoke(makeInvocation(`manual-${manualIndex}-${label}`), owner);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: COMPANY_ID,
        agentId: principal.agentId!,
        status: "running",
        contextSnapshot: { paperclipPluginExecution: { attemptId: row.id } },
        startedAt: new Date(),
      });
      await attempts.bindHeartbeat(row.id, runId);
      return { row, runId };
    };

    const preStart = await manuallyStart("pre-start-pin-drift");
    await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, pinnedSkill.id));
    await expect(attempts.start(preStart.row.id, preStart.runId, principal.agentId!, "codex_local"))
      .rejects.toMatchObject({ status: 409 });
    await db.update(companySkills).set({ currentVersionId: pinnedVersion.id }).where(eq(companySkills.id, pinnedSkill.id));
    await expect(attempts.start(preStart.row.id, preStart.runId, principal.agentId!, "codex_local"))
      .rejects.toMatchObject({ status: 409 });
    expect((await attempts.getRow(preStart.row.id))?.terminalReason).toBe("skill_pin_drift");
    expect(adapterCalls).toBe(3);

    const postStart = await manuallyStart("post-start-pin-drift");
    const postStarted = await attempts.start(postStart.row.id, postStart.runId, principal.agentId!, "codex_local");
    capturedTokens.push(postStarted.token);
    await db.update(companySkillVersions).set({
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# Drifted after start" }],
    }).where(eq(companySkillVersions.id, pinnedVersion.id));
    expect((await rpc(httpService.baseUrl, postStarted.token, postStart.row.id, "tools/list")).status).toBe(409);
    await db.update(companySkillVersions).set({ fileInventory: pinnedVersion.fileInventory }).where(eq(companySkillVersions.id, pinnedVersion.id));
    expect((await rpc(httpService.baseUrl, postStarted.token, postStart.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: { sourceIssueId: SOURCE_ISSUE_ID, material: true, summary: "restored pin must remain terminal" },
    })).status).toBe(409);
    expect((await attempts.getRow(postStart.row.id))?.terminalReason).toBe("skill_pin_drift");
    expect(adapterCalls).toBe(3);

    const timeoutAttempt = await manuallyStart("runtime-timeout");
    const timeoutStarted = await attempts.start(timeoutAttempt.row.id, timeoutAttempt.runId, principal.agentId!, "codex_local");
    capturedTokens.push(timeoutStarted.token);
    await db.update(pluginExecutionAttempts).set({ runtimeExpiresAt: new Date(Date.now() - 1) })
      .where(eq(pluginExecutionAttempts.id, timeoutAttempt.row.id));
    expect((await rpc(httpService.baseUrl, timeoutStarted.token, timeoutAttempt.row.id, "tools/list")).status).toBe(403);
    expect((await attempts.getRow(timeoutAttempt.row.id))?.status).toBe("timed_out");

    const callbackFirst = await manuallyStart("callback-first-race");
    const callbackFirstStarted = await attempts.start(callbackFirst.row.id, callbackFirst.runId, principal.agentId!, "codex_local");
    capturedTokens.push(callbackFirstStarted.token);
    const callbackPayload = { sourceIssueId: SOURCE_ISSUE_ID, material: true, summary: "callback wins" };
    expect((await rpc(httpService.baseUrl, callbackFirstStarted.token, callbackFirst.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: callbackPayload,
    })).status).toBe(200);
    expect((await attempts.terminalize(callbackFirst.row.id, "cancelled", "late_completion")).status).toBe("succeeded");
    expect((await rpc(httpService.baseUrl, callbackFirstStarted.token, callbackFirst.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: callbackPayload,
    })).status).toBe(200);
    expect(worker.calls.filter((call) => call.runId === callbackFirst.runId)).toHaveLength(1);
    expect((await rpc(httpService.baseUrl, callbackFirstStarted.token, callbackFirst.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: { ...callbackPayload, summary: "conflicting replay" },
    })).status).toBe(409);
    expect(worker.calls.filter((call) => call.runId === callbackFirst.runId)).toHaveLength(1);

    const originalNow = Date.now;
    try {
      Date.now = () => new Date(callbackFirstStarted.row.callbackExpiresAt).getTime() + 1;
      await expect(attempts.validateScope(scopeFromToken(callbackFirstStarted.token), "callback"))
        .rejects.toMatchObject({ status: 403 });
    } finally {
      Date.now = originalNow;
    }
    expect((await attempts.getRow(callbackFirst.row.id))?.status).toBe("succeeded");

    const completionFirst = await manuallyStart("completion-first-race");
    const completionFirstStarted = await attempts.start(completionFirst.row.id, completionFirst.runId, principal.agentId!, "codex_local");
    capturedTokens.push(completionFirstStarted.token);
    expect((await attempts.terminalize(completionFirst.row.id, "cancelled", "completion_won")).status).toBe("cancelled");
    expect((await rpc(httpService.baseUrl, completionFirstStarted.token, completionFirst.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: { ...callbackPayload, summary: "too late" },
    })).status).toBe(409);
    expect((await attempts.getRow(completionFirst.row.id))?.status).toBe("cancelled");

    const pendingRace = await manuallyStart("pending-callback-race");
    const pendingStarted = await attempts.start(pendingRace.row.id, pendingRace.runId, principal.agentId!, "codex_local");
    capturedTokens.push(pendingStarted.token);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    worker.setImplementation(async (pluginId: string, params: any) => {
      worker.calls.push({ pluginId, toolName: params.toolName, runId: params.runContext.runId });
      enteredResolve();
      await release;
      return { content: "late", data: { recorded: true, revision: "too-late" } };
    });
    const pendingResponse = rpc(httpService.baseUrl, pendingStarted.token, pendingRace.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: { ...callbackPayload, summary: "pending race" },
    });
    await entered;
    expect((await attempts.terminalize(pendingRace.row.id, "reclaimed", "completion_during_callback")).status).toBe("reclaimed");
    releaseResolve();
    expect((await pendingResponse).status).toBe(409);
    expect((await attempts.getRow(pendingRace.row.id))?.status).toBe("reclaimed");
    worker.resetImplementation();

    const explicitReclaim = await manuallyStart("explicit-reclaim");
    const explicitReclaimStarted = await attempts.start(explicitReclaim.row.id, explicitReclaim.runId, principal.agentId!, "codex_local");
    capturedTokens.push(explicitReclaimStarted.token);
    expect((await attempts.terminalize(explicitReclaim.row.id, "reclaimed", "coordinator_reclaim")).status).toBe("reclaimed");
    expect((await rpc(httpService.baseUrl, explicitReclaimStarted.token, explicitReclaim.row.id, "tools/call", {
      name: CALLBACK_TOOL,
      arguments: { ...callbackPayload, summary: "reclaimed callback" },
    })).status).toBe(409);

    const sourceAfter = await db.select().from(issues).where(eq(issues.id, SOURCE_ISSUE_ID)).then((rows) => rows[0]!);
    expect({
      title: sourceAfter.title,
      description: sourceAfter.description,
      status: sourceAfter.status,
      priority: sourceAfter.priority,
      completedAt: sourceAfter.completedAt?.toISOString(),
      updatedAt: sourceAfter.updatedAt.toISOString(),
    }).toEqual({
      title: sourceBefore.title,
      description: sourceBefore.description,
      status: sourceBefore.status,
      priority: sourceBefore.priority,
      completedAt: sourceBefore.completedAt?.toISOString(),
      updatedAt: sourceBefore.updatedAt.toISOString(),
    });

    services.dispose();
    await httpService.stop();
    httpService = null;
    const restartedDb = createDb(tempDb!.connectionString);
    restartedHttpService = await startHttpService(restartedDb, worker.manager);
    process.env.PAPERCLIP_API_URL = `${restartedHttpService.baseUrl}/api`;
    expect(restartedHttpService.dispatcher.listToolsForAgent().map((tool) => tool.name)).toEqual([CALLBACK_TOOL]);

    const durableAttempts = await restartedDb.select({
      id: pluginExecutionAttempts.id,
      heartbeatRunId: pluginExecutionAttempts.heartbeatRunId,
      status: pluginExecutionAttempts.status,
      billingCode: pluginExecutionAttempts.billingCode,
      provider: pluginExecutionAttempts.provider,
      biller: pluginExecutionAttempts.biller,
      model: pluginExecutionAttempts.model,
      inputTokens: pluginExecutionAttempts.inputTokens,
      cachedInputTokens: pluginExecutionAttempts.cachedInputTokens,
      outputTokens: pluginExecutionAttempts.outputTokens,
      durationMs: pluginExecutionAttempts.durationMs,
      billingType: pluginExecutionAttempts.billingType,
      billingStatus: pluginExecutionAttempts.billingStatus,
      costCents: pluginExecutionAttempts.costCents,
      capabilityTokenDigest: pluginExecutionAttempts.capabilityTokenDigest,
    }).from(pluginExecutionAttempts).where(inArray(pluginExecutionAttempts.id, goldenAttemptIds)).orderBy(asc(pluginExecutionAttempts.startedAt));
    const durableHeartbeats = await restartedDb.select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      usageJson: heartbeatRuns.usageJson,
    }).from(heartbeatRuns).where(inArray(heartbeatRuns.id, goldenRunIds)).orderBy(asc(heartbeatRuns.startedAt));
    const durableActivities = await restartedDb.select({
      action: activityLog.action,
      entityId: activityLog.entityId,
      runId: activityLog.runId,
    }).from(activityLog).where(and(
      eq(activityLog.entityType, "plugin_execution_attempt"),
      inArray(activityLog.entityId, goldenAttemptIds),
    )).orderBy(asc(activityLog.createdAt));
    const durableCosts = await restartedDb.select({
      heartbeatRunId: costEvents.heartbeatRunId,
      billingCode: costEvents.billingCode,
      provider: costEvents.provider,
      biller: costEvents.biller,
      model: costEvents.model,
      inputTokens: costEvents.inputTokens,
      cachedInputTokens: costEvents.cachedInputTokens,
      outputTokens: costEvents.outputTokens,
      billingType: costEvents.billingType,
      costStatus: costEvents.costStatus,
      costCents: costEvents.costCents,
    }).from(costEvents).where(inArray(costEvents.heartbeatRunId, goldenRunIds)).orderBy(asc(costEvents.createdAt));
    const durableEvents = await restartedDb.select().from(heartbeatRunEvents)
      .where(inArray(heartbeatRunEvents.runId, goldenRunIds));

    expect(durableAttempts).toHaveLength(3);
    expect(durableHeartbeats).toHaveLength(3);
    expect(durableCosts).toHaveLength(3);
    expect(durableEvents.length).toBeGreaterThanOrEqual(6);
    expect(durableActivities.filter((row) => row.action === "plugin_execution.callback_allowed")).toHaveLength(3);
    for (const row of durableAttempts) {
      expect(row.status).toBe("succeeded");
      expect(row.billingCode).toBe(BILLING_CODE);
      expect(row.provider).toBe("fake-local");
      expect(row.model).toBe("fixture-model");
      expect(row.durationMs).not.toBeNull();
      expect(row.capabilityTokenDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const attemptById = new Map(durableAttempts.map((row) => [row.id, row]));
    const costByRun = new Map(durableCosts.map((row) => [row.heartbeatRunId, row]));
    for (const id of goldenAttemptIds) {
      const attempt = attemptById.get(id)!;
      const cost = costByRun.get(attempt.heartbeatRunId)!;
      expect(cost).toMatchObject({
        billingCode: BILLING_CODE,
        provider: attempt.provider,
        biller: attempt.biller,
        model: attempt.model,
        inputTokens: attempt.inputTokens,
        cachedInputTokens: attempt.cachedInputTokens,
        outputTokens: attempt.outputTokens,
        billingType: attempt.billingType,
        costStatus: attempt.billingStatus,
        costCents: attempt.costCents,
      });
    }
    expect(attemptById.get(priced.attempt.id)).toMatchObject({ billingType: "metered_api", billingStatus: "reported", costCents: 12 });
    expect(attemptById.get(subscription.attempt.id)).toMatchObject({ billingType: "subscription_included", billingStatus: "reported", costCents: 0 });
    expect(attemptById.get(unpriced.attempt.id)).toMatchObject({ billingType: "unknown", billingStatus: "unpriced", costCents: 0 });

    const allPersistedRows = JSON.stringify({
      attempts: await restartedDb.select().from(pluginExecutionAttempts),
      heartbeats: await restartedDb.select().from(heartbeatRuns),
      activities: await restartedDb.select().from(activityLog),
      costs: await restartedDb.select().from(costEvents),
    });
    expect(capturedTokens.every((token) => !allPersistedRows.includes(token))).toBe(true);
    expect(allPersistedRows).not.toContain(TEST_JWT_SECRET);

    evidence!.restartBoundary = { before: "service-boot-1", after: "service-boot-2", sameDatabase: true };
    evidence!.cases = {
      goldenHttpLifecycle: "pass",
      ordinaryApiDenial: "pass",
      crossIdentityClaims: "pass",
      preStartPinDriftRestoration: "pass",
      postStartPinDriftRestoration: "pass",
      runtime120SecondCeiling: "pass",
      callbackFiveMinuteExpiry: "pass",
      callbackFirstRace: "pass",
      completionFirstRace: "pass",
      pendingCallbackRace: "pass",
      cancelAndReclaim: "pass",
      identicalReplayAndConflict: "pass",
      completedSourceIssueImmutable: "pass",
      pricedSubscriptionUnpricedRestartReadback: "pass",
    };
    evidence!.durableRows = {
      attempts: durableAttempts.map((row) => ({ ...row, id: digest(row.id), heartbeatRunId: digest(row.heartbeatRunId!), capabilityTokenDigest: row.capabilityTokenDigest })),
      heartbeats: durableHeartbeats.map((row) => ({ ...row, id: digest(row.id) })),
      activities: durableActivities.map((row) => ({ ...row, entityId: row.entityId ? digest(row.entityId) : null, runId: row.runId ? digest(row.runId) : null })),
      costs: durableCosts.map((row) => ({ ...row, heartbeatRunId: row.heartbeatRunId ? digest(row.heartbeatRunId) : null })),
    };
    evidence!.plaintextTokenPersisted = false;
  }, 60_000);
});
