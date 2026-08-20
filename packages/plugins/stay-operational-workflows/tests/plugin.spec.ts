import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Project } from "@paperclipai/shared";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_B_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = { id: PROJECT_A_ID, companyId: COMPANY_A_ID } as Project;
const PROJECT_B = { id: PROJECT_B_ID, companyId: COMPANY_B_ID } as Project;

const ACTOR: PluginApiRequestInput["actor"] = {
  actorType: "user",
  actorId: "board-user",
  userId: "board-user",
  agentId: null,
  runId: null,
};

function apiRequest(
  routeKey: string,
  companyId: string,
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
): PluginApiRequestInput {
  return {
    routeKey,
    method: "POST",
    path: "/test",
    params,
    query: {},
    body,
    actor: ACTOR,
    companyId,
    headers: {},
  };
}

function configBody(projectId: string): Record<string, unknown> {
  return {
    projectId,
    module: "outline",
    enabled: true,
    readOnly: true,
    destinationEnabled: false,
  };
}

describe("stay operational workflows plugin", () => {
  it("declares shadow foundations plus an approval-gated Sentry notification surface", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "staydigital.stay-operational-workflows",
      database: {
        namespaceSlug: "stay_operational_workflows",
        migrationsDir: "migrations",
        coreReadTables: ["companies", "issues", "projects", "agents"],
      },
      jobs: expect.arrayContaining([
        expect.objectContaining({ jobKey: "reconcile", schedule: "*/5 * * * *" }),
        expect.objectContaining({ jobKey: "sentry-poll", schedule: "*/5 * * * *" }),
      ]),
    });
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("jobs.schedule");
    expect(manifest.capabilities).toContain("database.namespace.write");
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.capabilities).toContain("secrets.read-ref");
    expect(manifest.capabilities).toContain("projects.read");
    expect(manifest.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentKey: "outline-runtime", identityOnly: "tool_profile" }),
      expect.objectContaining({ agentKey: "sentry-triage", status: "idle" }),
    ]));
    expect(manifest.managedToolProfiles).toEqual([expect.objectContaining({
      profileKey: "outline", tools: ["list_documents", "create_document", "update_document"],
    })]);
    expect(manifest.skills).toEqual([expect.objectContaining({ skillKey: "sentry-triage-proposal" })]);
    expect(manifest.entrypoints.ui).toBeUndefined();
  });

  it("registers scheduled reconciliation and event latency hints without persisting event payloads", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      title: "customer@example.com",
      authorization: "Bearer do-not-store",
      rawProviderPayload: { requestBody: "private" },
    };
    await harness.emit("issue.created", payload, {
      companyId: "company-a",
      entityId: "00000000-0000-4000-8000-000000000001",
      entityType: "issue",
    });
    const persistedParams = JSON.stringify(harness.dbExecutes.map((entry) => entry.params));
    expect(persistedParams).not.toContain("customer@example.com");
    expect(persistedParams).not.toContain("Bearer do-not-store");
    expect(persistedParams).not.toContain("requestBody");
    expect(harness.dbQueries.some((entry) => entry.sql.includes("project_configs"))).toBe(true);
    expect(harness.dbQueries.every((entry) => !JSON.stringify(entry.params).includes("rawProviderPayload"))).toBe(true);
  });

  it("uses the host-authorized company on config writes and rejects spoofed body scope", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ projects: [{ id: "00000000-0000-4000-8000-000000000001", companyId: "company-a" } as Project] });
    await plugin.definition.setup(harness.ctx);
    const response = await plugin.definition.onApiRequest?.({
      routeKey: "config.upsert",
      method: "POST",
      path: "/config",
      params: {},
      query: {},
      body: {
        companyId: "company-b",
        projectId: "00000000-0000-4000-8000-000000000001",
        module: "outline",
        enabled: true,
        readOnly: true,
        destinationEnabled: false,
      },
      actor: {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
        agentId: null,
        runId: null,
      },
      companyId: "company-a",
      headers: {},
    });

    expect(response?.body).toMatchObject({
      config: {
        companyId: "company-a",
        module: "outline",
      },
      mode: "shadow",
      externalWritesEnabled: false,
    });
    expect(harness.dbExecutes[0]?.params).toContain("company-a");
    expect(harness.dbExecutes[0]?.params).not.toContain("company-b");
    expect(harness.activity).toEqual([
      expect.objectContaining({ companyId: "company-a" }),
    ]);
  });

  it("isolates config, report, manual reconcile, and replay across two company/project pairs", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ projects: [PROJECT_A, PROJECT_B] });
    await plugin.definition.setup(harness.ctx);

    await plugin.definition.onApiRequest?.(
      apiRequest("config.upsert", COMPANY_A_ID, configBody(PROJECT_A_ID)),
    );
    await plugin.definition.onApiRequest?.(
      apiRequest("config.upsert", COMPANY_B_ID, configBody(PROJECT_B_ID)),
    );
    const configWrites = harness.dbExecutes.filter((entry) => entry.sql.includes("project_configs"));
    expect(configWrites.map((entry) => [entry.params?.[1], entry.params?.[2]])).toEqual([
      [COMPANY_A_ID, PROJECT_A_ID],
      [COMPANY_B_ID, PROJECT_B_ID],
    ]);

    const foreignProject = await plugin.definition.onApiRequest?.(
      apiRequest("config.upsert", COMPANY_A_ID, configBody(PROJECT_B_ID)),
    );
    expect(foreignProject).toEqual({
      status: 404,
      body: { error: "Project not found", code: "project_not_found" },
    });
    expect(JSON.stringify(foreignProject)).not.toContain(PROJECT_B_ID);
    expect(JSON.stringify(foreignProject)).not.toContain(COMPANY_B_ID);
    expect(harness.dbExecutes.filter((entry) => entry.sql.includes("project_configs"))).toHaveLength(2);
    expect(harness.activity).toHaveLength(2);

    const reportAStart = harness.dbQueries.length;
    await plugin.definition.onApiRequest?.(apiRequest("report", COMPANY_A_ID));
    const reportAQueries = harness.dbQueries.slice(reportAStart);
    expect(reportAQueries).toHaveLength(4);
    expect(reportAQueries.every((entry) => entry.params?.[0] === COMPANY_A_ID)).toBe(true);

    const reportBStart = harness.dbQueries.length;
    await plugin.definition.onApiRequest?.(apiRequest("report", COMPANY_B_ID));
    const reportBQueries = harness.dbQueries.slice(reportBStart);
    expect(reportBQueries).toHaveLength(4);
    expect(reportBQueries.every((entry) => entry.params?.[0] === COMPANY_B_ID)).toBe(true);

    const manualQueryStart = harness.dbQueries.length;
    const manualExecuteStart = harness.dbExecutes.length;
    const manual = await plugin.definition.onApiRequest?.(apiRequest("reconcile.manual", COMPANY_A_ID));
    expect(manual?.body).toMatchObject({ companyId: COMPANY_A_ID, scanned: 0, externalWrites: 0 });
    expect(harness.dbQueries.slice(manualQueryStart).every((entry) => entry.params?.[0] === COMPANY_A_ID))
      .toBe(true);
    expect(harness.dbExecutes.slice(manualExecuteStart).every((entry) => entry.params?.includes(COMPANY_A_ID)))
      .toBe(true);

    const operationBId = "33333333-3333-4333-8333-333333333333";
    const foreignReplay = await plugin.definition.onApiRequest?.(
      apiRequest("operation.replay", COMPANY_A_ID, {}, { operationId: operationBId }),
    );
    expect(foreignReplay).toEqual({
      status: 404,
      body: { error: "Operation not found", code: "operation_not_found" },
    });
    expect(JSON.stringify(foreignReplay)).not.toContain(operationBId);
    expect(JSON.stringify(foreignReplay)).not.toContain(COMPANY_B_ID);
    expect(harness.dbQueries.at(-1)?.params).toEqual([COMPANY_A_ID, operationBId]);
    expect(harness.activity).toHaveLength(3);
  });

  it.each([
    ["readOnly=false", { readOnly: false }],
    ["destinationEnabled=true", { destinationEnabled: true }],
    ["an invalid module", { module: "invalid" }],
    ["batchSize=0", { batchSize: 0 }],
  ])("returns a redacted 422 for %s before persistence", async (_case, override) => {
    const harness = createTestHarness({ manifest });
    harness.seed({ projects: [PROJECT_A] });
    await plugin.definition.setup(harness.ctx);
    const response = await plugin.definition.onApiRequest?.(
      apiRequest("config.upsert", COMPANY_A_ID, {
        ...configBody(PROJECT_A_ID),
        ...override,
        secret: "must-not-echo",
      }),
    );

    expect(response).toEqual({
      status: 422,
      body: {
        error: "Workflow configuration validation failed",
        code: "invalid_workflow_config",
      },
    });
    expect(JSON.stringify(response)).not.toContain("must-not-echo");
    expect(harness.dbExecutes).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
  });

  it("locks the migration to zero external writes and redacted storage columns", async () => {
    const sql = await readFile(new URL("../migrations/001_shadow_foundation.sql", import.meta.url), "utf8");
    expect(sql).toContain("external_write_count integer NOT NULL DEFAULT 0 CHECK (external_write_count = 0)");
    expect(sql).toContain("read_only boolean NOT NULL DEFAULT true CHECK (read_only = true)");
    expect(sql).toContain("destination_enabled boolean NOT NULL DEFAULT false CHECK (destination_enabled = false)");
    expect(sql).toContain("outcome_receipt jsonb");
    expect(sql).toContain("summary_redacted text");
    expect(sql).not.toMatch(/raw_payload|request_body|secret_value|customer_email/i);
  });

  it("scopes the activation migration to the outline module and keeps non-negative counters", async () => {
    const sql = await readFile(new URL("../migrations/005_outline_activation.sql", import.meta.url), "utf8");
    expect(sql).toContain("CHECK (read_only = true OR module = 'outline')");
    expect(sql).toContain("CHECK (destination_enabled = false OR module = 'outline')");
    expect(sql).toContain("CHECK (outline_activation IS NULL OR module = 'outline')");
    expect(sql).toContain("'published'");
    expect(sql).toContain("CHECK (external_write_count >= 0)");
    expect(sql).not.toMatch(/secret|token|bearer/i);
  });

  it("rejects an unusable outline activation before persistence and reports the gated modes", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ projects: [PROJECT_A] });
    await plugin.definition.setup(harness.ctx);

    const destination = {
      accessMode: "mcp",
      connectionId: "outline-sandbox",
      tools: {
        documentsInfo: "list_documents",
        documentsCreate: "create_document",
        documentsUpdate: "update_document",
      },
      targets: {
        architecture: { collectionId: "89f93133-b508-4143-a281-d19488881eb9", parentDocumentId: "6806f4b9-36ed-442b-a91e-43ee75f4dcb1", parentTitle: "Architecture" },
        reports: { collectionId: "89f93133-b508-4143-a281-d19488881eb9", parentDocumentId: "43333bc2-f05b-47c7-bdd4-03fd43534c76", parentTitle: "Reports" },
        processes: { collectionId: "89f93133-b508-4143-a281-d19488881eb9", parentDocumentId: "0f5fcd02-9849-4b1d-a36c-1ed6efe2ac30", parentTitle: "Processes" },
      },
    };
    const rejected = await plugin.definition.onApiRequest?.(
      apiRequest("config.upsert", COMPANY_A_ID, {
        ...configBody(PROJECT_A_ID),
        readOnly: false,
        destinationEnabled: true,
        destinationKey: "outline-sandbox",
        outlineActivation: {
          schemaVersion: 1,
          destination,
          authorization: {
            enabled: true,
            readOnly: false,
            externalWritesEnabled: true,
            exactConfigurationApproval: {
              status: "accepted",
              configurationRevisionId: "rev-1",
              configurationFingerprint: "sha256:not-the-approved-fingerprint",
              interactionId: "int-1",
              acceptedAt: "2026-08-07T09:30:00.000Z",
            },
            writerProofs: [],
          },
        },
      }),
    );
    expect(rejected).toEqual({
      status: 422,
      body: {
        error: "Workflow configuration validation failed",
        code: "invalid_workflow_config",
      },
    });
    expect(harness.dbExecutes).toHaveLength(0);
  });

  it("reports the activation-gated Outline mode, shadow ClickUp, and separately gated Sentry mode", async () => {
    const health = await plugin.definition.onHealth?.();
    expect(health).toMatchObject({
      status: "ok",
      details: {
        outlineMode: "activation-gated",
        clickupMode: "shadow",
        sentryMode: "configuration-gated",
        slackApprovalCapability: false,
        authoritativeSource: "scheduled-reconciliation",
        eventRole: "latency-hint",
      },
    });
  });
});
