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
  it("declares only shadow foundation capabilities and no provider write surface", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "staydigital.stay-operational-workflows",
      database: {
        namespaceSlug: "stay_operational_workflows",
        migrationsDir: "migrations",
        coreReadTables: ["companies", "issues", "projects"],
      },
      jobs: [expect.objectContaining({ jobKey: "reconcile", schedule: "*/5 * * * *" })],
    });
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("jobs.schedule");
    expect(manifest.capabilities).toContain("database.namespace.write");
    expect(manifest.capabilities).not.toContain("http.outbound");
    expect(manifest.capabilities).not.toContain("secrets.read-ref");
    expect(manifest.capabilities).toContain("projects.read");
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

    await expect(plugin.definition.onApiRequest?.(
      apiRequest("config.upsert", COMPANY_A_ID, configBody(PROJECT_B_ID)),
    )).rejects.toThrow(/authorized company/);
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
    await expect(plugin.definition.onApiRequest?.(
      apiRequest("operation.replay", COMPANY_A_ID, {}, { operationId: operationBId }),
    )).rejects.toThrow(/authorized company/);
    expect(harness.dbQueries.at(-1)?.params).toEqual([COMPANY_A_ID, operationBId]);
    expect(harness.activity).toHaveLength(3);
  });

  it("rejects provider-write configuration before persistence", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await expect(plugin.definition.onApiRequest?.({
      routeKey: "config.upsert",
      method: "POST",
      path: "/config",
      params: {},
      query: {},
      body: {
        projectId: "00000000-0000-4000-8000-000000000001",
        module: "clickup",
        enabled: true,
        readOnly: true,
        destinationEnabled: true,
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
    })).rejects.toThrow(/shadow-only/);
    expect(harness.dbExecutes).toHaveLength(0);
  });

  it("locks the migration to zero external writes and redacted storage columns", async () => {
    const sql = await readFile(new URL("../migrations/001_shadow_foundation.sql", import.meta.url), "utf8");
    expect(sql).toContain("external_write_count integer NOT NULL DEFAULT 0 CHECK (external_write_count = 0)");
    expect(sql).toContain("read_only boolean NOT NULL DEFAULT true CHECK (read_only = true)");
    expect(sql).toContain("destination_enabled boolean NOT NULL DEFAULT false CHECK (destination_enabled = false)");
    expect(sql).toContain("outcome_receipt jsonb");
    expect(sql).toContain("summary_redacted text");
    expect(sql).not.toMatch(/raw_payload|request_body|authorization|secret_value|customer_email/i);
  });

  it("reports health as shadow-only with scheduled reconciliation authoritative", async () => {
    const health = await plugin.definition.onHealth?.();
    expect(health).toMatchObject({
      status: "ok",
      details: {
        mode: "shadow",
        externalWritesEnabled: false,
        authoritativeSource: "scheduled-reconciliation",
        eventRole: "latency-hint",
      },
    });
  });
});
