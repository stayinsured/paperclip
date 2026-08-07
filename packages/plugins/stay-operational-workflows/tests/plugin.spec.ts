import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

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
