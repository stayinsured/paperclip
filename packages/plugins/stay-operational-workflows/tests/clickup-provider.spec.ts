import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ClickUpApiClient } from "../src/modules/clickup/provider.js";
import type { ClickUpDestinationConfig, ClickUpShadowProjection } from "../src/modules/clickup/types.js";

const config: ClickUpDestinationConfig = {
  apiBaseUrl: "https://api.clickup.com/api/v2/",
  tokenSecretId: "managed-secret-id",
  workspaceId: "90151122957",
  spaceId: "approved-space",
  listId: "901511200089",
  statuses: {
    toDo: { id: "status-todo", name: "to do" },
    inProgress: { id: "status-progress", name: "in progress" },
    done: { id: "status-done", name: "done" },
  },
  ownerAssigneeId: 94656177,
};

const projection: ClickUpShadowProjection = {
  schemaVersion: 1,
  mode: "shadow",
  wouldWrite: false,
  companyId: "company-a",
  projectId: "project-a",
  issueId: "issue-a",
  issueIdentifier: "DEMO-101",
  listId: config.listId,
  correlationValue: "pc:issue-a:stable",
  projectionVersion: "projection-1",
  title: "[DEMO-101] Implement ClickUp mirroring",
  description: [
    "<!-- paperclip-sync:start -->",
    "Paperclip mirror. Paperclip is authoritative.",
    "Owner label: Backend & Integrations Engineer",
    "Paperclip status: in_progress",
    "Forecast source: plan",
    "Forecast revision: revision-1",
    "",
    "Planning summary:",
    "Implement the mirror.",
    "",
    "Acceptance criteria:",
    "Readback is exact.",
    "",
    "Blockers:",
    "None",
    "",
    "paperclip-correlation: pc:issue-a:stable",
    "paperclip-projection: projection-1",
    "<!-- paperclip-sync:end -->",
  ].join("\n"),
  statusId: config.statuses.inProgress.id,
  statusName: config.statuses.inProgress.name,
  nativeAssigneeId: config.ownerAssigneeId,
  timeEstimateMs: 4 * 60 * 60 * 1_000,
  dueDateMs: Date.parse("2026-09-11T00:00:00.000Z"),
  parentTaskId: null,
  customFields: {},
  ownedSnapshot: {
    title: "[DEMO-101] Implement ClickUp mirroring",
    planningSummary: "Implement the mirror.",
    status: config.statuses.inProgress.id,
    assigneeDisplay: "Backend & Integrations Engineer",
    blocker: null,
    acceptanceSummary: "Readback is exact.",
    estimate: 4,
    nativeAssignee: config.ownerAssigneeId,
    dueDate: Date.parse("2026-09-11T00:00:00.000Z"),
    sourceStatus: "in_progress",
    forecastSource: "plan",
    forecastRevision: "revision-1",
  },
  sourceUpdatedAt: "2026-08-28T10:00:00.000Z",
  generatedAt: "2026-08-28T10:01:00.000Z",
};

type CapturedCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

function providerHarness() {
  const calls: CapturedCall[] = [];
  let revision = 0;
  let task: Record<string, unknown> | null = null;
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const http = {
    fetch: async (rawUrl: string, init: RequestInit = {}) => {
      const url = new URL(rawUrl);
      const method = init.method ?? "GET";
      const headers = { authorization: new Headers(init.headers).get("authorization") ?? "" };
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url: rawUrl, method, headers, body });
      const taskPath = "/api/v2/task/task-1";
      if (method === "POST" && url.pathname === `/api/v2/list/${config.listId}/task`) {
        revision += 1;
        task = {
          id: "task-1",
          name: body!.name,
          description: body!.description,
          assignees: ((body!.assignees as number[]) ?? []).map((id) => ({ id })),
          due_date: body!.due_date,
          status: { id: projection.statusId, status: projection.statusName },
          list: { id: config.listId },
          url: "https://app.clickup.com/t/task-1",
          date_updated: String(Date.parse("2026-08-28T10:01:00.000Z") + revision),
          time_estimate: body!.time_estimate,
          custom_fields: (body!.custom_fields as Array<{ id: string; value: unknown }> | undefined) ?? [],
          parent: null,
          dependencies: [],
        };
        return response(task);
      }
      if (method === "GET" && url.pathname === taskPath) return response(task);
      if (method === "PUT" && url.pathname === taskPath) {
        revision += 1;
        task = { ...task!, ...("name" in body! ? { name: body!.name } : {}), ...("parent" in body! ? { parent: body!.parent } : {}), date_updated: String(Date.now() + revision) };
        return response(task);
      }
      const fieldMatch = url.pathname.match(/^\/api\/v2\/task\/task-1\/field\/(.+)$/);
      if (fieldMatch && (method === "POST" || method === "DELETE")) {
        const fields = (task!.custom_fields as Array<{ id: string; value: unknown }>).filter((field) => field.id !== fieldMatch[1]);
        if (method === "POST") fields.push({ id: fieldMatch[1]!, value: body!.value });
        task = { ...task!, custom_fields: fields, date_updated: String(Date.now() + ++revision) };
        return response({});
      }
      if (url.pathname === `${taskPath}/dependency` && method === "POST") {
        task = { ...task!, dependencies: [{ depends_on: body!.depends_on }] };
        return response({});
      }
      if (url.pathname === `${taskPath}/dependency` && method === "DELETE") {
        task = { ...task!, dependencies: [] };
        return response({});
      }
      return new Response(JSON.stringify({ err: "unexpected request" }), { status: 404 });
    },
  } as unknown as PluginContext["http"];
  return { calls, http };
}

describe("ClickUp list-scoped provider", () => {
  it("uses only the approved API base/list and implements native fields, parent, dependency, and readback calls", async () => {
    const harness = providerHarness();
    const client = new ClickUpApiClient(harness.http, config, "synthetic-token");
    const created = await client.createTask(projection);
    expect(created).toMatchObject({ id: "task-1", listId: config.listId });
    const updated = await client.updateTask("task-1", { ...projection, title: "Updated mirror" });
    expect(updated.title).toBe("Updated mirror");
    await client.updateParent("task-1", "task-parent");
    await client.addDependency("task-1", "task-blocker");
    expect(await client.getTask("task-1")).toMatchObject({
      parentTaskId: "task-parent",
      dependencyTaskIds: ["task-blocker"],
    });
    await client.removeDependency("task-1", "task-blocker");

    expect(harness.calls.every((call) => call.url.startsWith("https://api.clickup.com/api/v2/"))).toBe(true);
    expect(harness.calls.find((call) => call.method === "POST" && call.url.includes("/list/"))?.url)
      .toBe(`https://api.clickup.com/api/v2/list/${config.listId}/task`);
    expect(harness.calls.filter((call) => call.url.includes("/field/"))).toHaveLength(0);
    const createBody = harness.calls.find((call) => call.method === "POST" && call.url.includes("/list/"))!.body as Record<string, unknown>;
    expect(createBody).not.toHaveProperty("custom_fields");
    expect(createBody).toMatchObject({ assignees: [config.ownerAssigneeId], due_date: projection.dueDateMs });
    expect(harness.calls.filter((call) => call.url.includes("/dependency"))).toHaveLength(2);
    expect(harness.calls.every((call) => call.headers.authorization === "synthetic-token")).toBe(true);
  });

  it("rejects a create for any other list before an HTTP call", async () => {
    const harness = providerHarness();
    const client = new ClickUpApiClient(harness.http, config, "synthetic-token");
    await expect(client.createTask({ ...projection, listId: "other-list" })).rejects.toEqual(
      expect.objectContaining({ code: "clickup_create_scope_mismatch" }),
    );
    expect(harness.calls).toEqual([]);
  });
});
