import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  companies,
  companySkills,
  createDb,
  heartbeatRuns,
  pluginExecutionAttempts,
  pluginEntities,
  pluginCompanySettings,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { assertAssignableAgent } from "../services/agent-assignability.js";
import { pluginExecutionAttemptService } from "../services/plugin-execution-attempts.js";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.managed-agents-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Agents Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agents.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    agents: [
      {
        agentKey: "wiki-maintainer",
        displayName: "Wiki Maintainer",
        role: "engineer",
        title: "Maintains plugin-owned knowledge",
        capabilities: "Maintains a plugin-owned wiki.",
        adapterType: "process",
        adapterConfig: { command: "pnpm wiki:maintain" },
        runtimeConfig: { modelProfiles: { cheap: { enabled: true, adapterConfig: { model: "small" } } } },
        permissions: { canCreateAgents: false },
        budgetMonthlyCents: 1234,
      },
    ],
  };
}

function restrictedManifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.restricted-principal-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Restricted Principal Test",
    description: "Test restricted execution principal",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agents.managed", "skills.managed", "agent.tools.register"],
    entrypoints: { worker: "./dist/worker.js" },
    tools: [{
      name: "maintain-document",
      displayName: "Maintain document",
      description: "Create or update one documentation record",
      parametersSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          markdown: { type: "string" },
          expectedRevision: { type: "string" },
        },
        required: ["documentId", "markdown", "expectedRevision"],
        additionalProperties: false,
      },
    }],
    skills: [{
      skillKey: "classify",
      displayName: "Classifier",
      files: [{ path: "SKILL.md", content: "# Classifier" }],
    }],
    agents: [{
      agentKey: "classifier",
      displayName: "Classifier",
      adapterType: "codex_local",
      executionPrincipal: {
        kind: "plugin_tool_only",
        skillKey: "classify",
        tool: "paperclip.restricted-principal-test:maintain-document",
      },
    }],
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-managed agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-managed agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginExecutionAttempts);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentConfigRevisions);
    await db.delete(pluginEntities);
    await db.delete(pluginManagedResources);
    await db.delete(companySkills);
    await db.delete(pluginCompanySettings);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(options: { requireApproval?: boolean; manifest?: PaperclipPluginManifestV1 } = {}) {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const pluginManifest = options.manifest ?? manifest();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: options.requireApproval ?? false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-managed-agents-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined, {
      manifest: pluginManifest,
    });
    return { companyId, pluginId, pluginManifest, services };
  }

  it("creates and resolves managed agents by stable resource key", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();

    const created = await services.agents.managedReconcile({
      companyId,
      agentKey: "wiki-maintainer",
    });

    expect(created.status).toBe("created");
    expect(created.agentId).toBeTruthy();
    expect(created.agent).toMatchObject({
      name: "Wiki Maintainer",
      role: "engineer",
      adapterConfig: { command: "pnpm wiki:maintain" },
    });

    const resolved = await services.agents.managedGet({
      companyId,
      agentKey: "wiki-maintainer",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.agentId).toBe(created.agentId);

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.entityType).toBe("managed_agent");
    expect(binding?.scopeKind).toBe("company");
    expect(binding?.scopeId).toBe(companyId);
    expect(binding?.data).toMatchObject({
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      agentId: created.agentId,
    });
  });

  it("preserves user edits during reconcile and resets only on explicit reset", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(created.agentId).toBeTruthy();

    await db
      .update(agents)
      .set({
        name: "Knowledge Lead",
        adapterConfig: { command: "custom" },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, created.agentId!));

    const reconciled = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(reconciled.status).toBe("resolved");
    expect(reconciled.agent).toMatchObject({
      name: "Knowledge Lead",
      adapterConfig: { command: "custom" },
    });

    const reset = await services.agents.managedReset({ companyId, agentKey: "wiki-maintainer" });
    expect(reset.status).toBe("reset");
    expect(reset.agent).toMatchObject({
      name: "Wiki Maintainer",
      adapterConfig: { command: "pnpm wiki:maintain" },
    });
  });

  it("creates managed agents with the most-used compatible company adapter", async () => {
    const pluginManifest = manifest();
    pluginManifest.agents![0] = {
      ...pluginManifest.agents![0]!,
      adapterType: "claude_local",
      adapterPreference: ["claude_local", "codex_local"],
      adapterConfig: {},
    };
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Codex One",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Codex Two",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Claude One",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(created.agent?.adapterType).toBe("codex_local");
  });

  it("materializes declared managed agent instructions with local folder paths", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-home-"));
    const wikiRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-agent-wiki-")));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    try {
      const pluginManifest = manifest();
      pluginManifest.localFolders = [
        {
          folderKey: "wiki-root",
          displayName: "Wiki root",
          access: "readWrite",
          requiredDirectories: [],
          requiredFiles: ["AGENTS.md"],
        },
      ];
      pluginManifest.agents![0] = {
        ...pluginManifest.agents![0]!,
        adapterType: "claude_local",
        adapterConfig: {},
        instructions: {
          entryFile: "AGENTS.md",
          content: [
            "# LLM Wiki Maintainer",
            "",
            "You are the LLM Wiki Maintainer.",
            "Wiki root: `{{localFolders.wiki-root.path}}`",
            "Wiki schema: `{{localFolders.wiki-root.agentsPath}}`",
            "",
          ].join("\n"),
        },
      };
      const { companyId, pluginId, services } = await seedCompanyAndPlugin({ manifest: pluginManifest });
      await fs.writeFile(path.join(wikiRoot, "AGENTS.md"), "# Wiki schema\n", "utf8");
      await db.insert(pluginCompanySettings).values({
        companyId,
        pluginId,
        enabled: true,
        settingsJson: {
          localFolders: {
            "wiki-root": {
              path: wikiRoot,
              access: "readWrite",
              requiredDirectories: [],
              requiredFiles: ["AGENTS.md"],
            },
          },
        },
      });

      const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

      const instructionsFilePath = created.agent?.adapterConfig.instructionsFilePath;
      expect(typeof instructionsFilePath).toBe("string");
      const content = await fs.readFile(instructionsFilePath as string, "utf8");
      expect(content).toContain("You are the LLM Wiki Maintainer.");
      expect(content).toContain(`Wiki root: \`${wikiRoot}\``);
      expect(content).toContain(`Wiki schema: \`${path.join(wikiRoot, "AGENTS.md")}\``);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(wikiRoot, { recursive: true, force: true });
    }
  });

  it("repairs a missing binding by relinking a same-company managed agent marker", async () => {
    const { companyId, pluginId, pluginManifest, services } = await seedCompanyAndPlugin();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Renamed Wiki Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "custom" },
      runtimeConfig: {},
      permissions: {},
      metadata: {
        paperclipManagedResource: {
          pluginId,
          pluginKey: pluginManifest.id,
          resourceKind: "agent",
          resourceKey: "wiki-maintainer",
        },
      },
    });

    const relinked = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });
    expect(relinked.status).toBe("relinked");
    expect(relinked.agentId).toBe(agentId);

    const [binding] = await db.select().from(pluginEntities);
    expect(binding?.data).toMatchObject({ agentId });
  });

  it("respects board approval policy for new managed agents", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ requireApproval: true });

    const created = await services.agents.managedReconcile({ companyId, agentKey: "wiki-maintainer" });

    expect(created.status).toBe("created");
    expect(created.agent?.status).toBe("pending_approval");
    expect(created.approvalId).toBeTruthy();

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, created.approvalId!));
    expect(approval).toMatchObject({
      type: "hire_agent",
      status: "pending",
    });
    expect(approval?.payload).toMatchObject({
      agentId: created.agentId,
      sourcePluginKey: "paperclip.managed-agents-test",
      managedResourceKey: "wiki-maintainer",
    });
  });

  it("keeps plugin execution principals outside assignment, ordinary invoke, and sessions", async () => {
    const { companyId, services } = await seedCompanyAndPlugin({ manifest: restrictedManifest() });
    const created = await services.agents.managedReconcile({ companyId, agentKey: "classifier" });
    expect(created.agent).toBeTruthy();
    expect(created.agent?.metadata).toMatchObject({
      pluginManagedAgent: {
        executionPrincipal: { kind: "plugin_tool_only" },
      },
    });
    expect(created.agent?.permissions).toMatchObject({
      canCreateAgents: false,
      canCreateSkills: false,
    });

    await expect(assertAssignableAgent(db, companyId, created.agentId!, "work"))
      .rejects.toThrow("Cannot assign work to plugin execution principals");
    await expect(services.agents.invoke({
      companyId,
      agentId: created.agentId!,
      prompt: "ordinary invoke",
    })).rejects.toThrow("plugin execution principals cannot be invoked through agents.invoke");
    await expect(services.agentSessions.create({
      companyId,
      agentId: created.agentId!,
    })).rejects.toThrow("plugin execution principals cannot use sessions");
  });

  it("enforces durable scope, replay, pin drift, timeout, and first-terminal-wins", async () => {
    const seeded = await seedCompanyAndPlugin({ manifest: restrictedManifest() });
    const principal = await seeded.services.agents.managedReconcile({
      companyId: seeded.companyId,
      agentKey: "classifier",
    });
    const skillResolution = await seeded.services.skills.managedReconcile({
      companyId: seeded.companyId,
      skillKey: "classify",
    });
    if (!skillResolution.skillId) throw new Error("Expected managed skill");
    await companySkillService(db).createVersion(
      seeded.companyId, skillResolution.skillId, { label: "Restricted execution pin" }, null,
    );
    const attempts = pluginExecutionAttemptService(db);
    const invocation = {
      companyId: seeded.companyId,
      principalAgentKey: "classifier",
      coordinatorAttemptId: "attempt-1",
      assessmentId: "assessment-1",
      source: { kind: "issue", id: "source-issue-1" },
      policy: { id: "materiality", version: "1" },
      nonce: "nonce-1",
      billingCode: "STA-1832/outline-materiality",
      envelope: { title: "Sanitized source", body: "No secrets" },
    };
    const owner = {
      pluginId: seeded.pluginId,
      pluginKey: seeded.pluginManifest.id,
      manifest: seeded.pluginManifest,
    };

    const first = await attempts.invoke(invocation, owner);
    expect((await attempts.invoke(invocation, owner)).id).toBe(first.id);
    await expect(attempts.invoke({
      ...invocation,
      source: { kind: "issue", id: "different-source" },
    }, owner)).rejects.toMatchObject({ status: 409 });

    const previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "plugin-execution-test-secret";
    try {
      async function startAttempt(coordinatorAttemptId: string) {
        const row = coordinatorAttemptId === invocation.coordinatorAttemptId
          ? first
          : await attempts.invoke({
              ...invocation,
              coordinatorAttemptId,
              assessmentId: `assessment-${coordinatorAttemptId}`,
              nonce: `nonce-${coordinatorAttemptId}`,
            }, owner);
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: seeded.companyId,
          agentId: principal.agentId!,
          status: "running",
          contextSnapshot: { paperclipPluginExecution: { attemptId: row.id } },
          startedAt: new Date(),
        });
        await attempts.bindHeartbeat(row.id, runId);
        const started = await attempts.start(row.id, runId, principal.agentId!, "codex_local");
        const claims = verifyLocalAgentJwt(started.token);
        if (claims?.key_scope?.kind !== "plugin_execution") {
          throw new Error("Expected plugin_execution JWT scope");
        }
        expect(new Date(started.row.runtimeExpiresAt).getTime() - started.row.startedAt!.getTime()).toBe(120_000);
        expect(new Date(started.row.callbackExpiresAt).getTime() - started.row.startedAt!.getTime()).toBe(300_000);
        return { ...started, scope: claims.key_scope };
      }

      const started = await startAttempt("attempt-1");
      await expect(attempts.validateScope({
        ...started.scope,
        policyVersion: "conflicting-policy",
      }, "callback")).rejects.toMatchObject({ status: 403 });

      const executeTool = vi.fn(async () => ({
        pluginId: seeded.pluginManifest.id,
        toolName: "maintain-document",
        result: { content: "updated", data: { updated: true, revision: "43" } },
      }));
      const dispatcher = {
        getTool: (name: string) => name === started.row.allowedTool
          ? {
              namespacedName: name,
              pluginDbId: seeded.pluginId,
              pluginId: seeded.pluginManifest.id,
              parametersSchema: seeded.pluginManifest.tools![0]!.parametersSchema,
            }
          : null,
        executeTool,
      } as any;

      await expect(attempts.callback(started.scope, "other.plugin:maintain-document", {}, dispatcher))
        .rejects.toMatchObject({ status: 403 });
      expect(executeTool).not.toHaveBeenCalled();

      const payload = { documentId: "doc-1", markdown: "# Maintained", expectedRevision: "42" };
      await expect(attempts.callback(
        started.scope,
        started.row.allowedTool,
        { documentId: "doc-1", markdown: 42, expectedRevision: "42" },
        dispatcher,
      )).rejects.toMatchObject({ status: 422 });
      expect(executeTool).not.toHaveBeenCalled();
      const accepted = await attempts.callback(started.scope, started.row.allowedTool, payload, dispatcher);
      expect(accepted).toMatchObject({ data: { updated: true, revision: "43" } });
      expect(await attempts.callback(started.scope, started.row.allowedTool, payload, dispatcher))
        .toEqual(accepted);
      expect(executeTool).toHaveBeenCalledTimes(1);
      await expect(attempts.callback(
        started.scope,
        started.row.allowedTool,
        { documentId: "doc-1", markdown: "# Different", expectedRevision: "42" },
        dispatcher,
      )).rejects.toMatchObject({ status: 409 });
      expect((await attempts.terminalize(started.row.id, "cancelled", "late_cancel")).status)
        .toBe("succeeded");

      const drifted = await startAttempt("attempt-2");
      await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, drifted.row.companySkillId));
      await expect(attempts.callback(
        drifted.scope,
        drifted.row.allowedTool,
        payload,
        dispatcher,
      )).rejects.toMatchObject({ status: 409 });
      expect((await attempts.getRow(drifted.row.id))?.terminalReason).toBe("skill_pin_drift");
      await db.update(companySkills).set({
        currentVersionId: drifted.row.companySkillVersionId,
      }).where(eq(companySkills.id, drifted.row.companySkillId));

      const timedOut = await startAttempt("attempt-3");
      await db.update(pluginExecutionAttempts).set({
        runtimeExpiresAt: new Date(Date.now() - 1),
      }).where(eq(pluginExecutionAttempts.id, timedOut.row.id));
      await expect(attempts.validateScope(timedOut.scope, "callback"))
        .rejects.toMatchObject({ status: 403 });
      expect((await attempts.getRow(timedOut.row.id))?.status).toBe("timed_out");

      const cancellable = await attempts.invoke({
        ...invocation,
        coordinatorAttemptId: "attempt-4",
        assessmentId: "assessment-4",
        nonce: "nonce-4",
      }, owner);
      expect((await attempts.terminalize(cancellable.id, "cancelled", "coordinator_cancel")).status)
        .toBe("cancelled");
      expect((await attempts.terminalize(cancellable.id, "reclaimed", "late_reclaim")).status)
        .toBe("cancelled");
    } finally {
      if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
    }
  });
});
