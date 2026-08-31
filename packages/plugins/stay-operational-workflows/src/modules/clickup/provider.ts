import type { PluginContext } from "@paperclipai/plugin-sdk";
import { mergeClickUpManagedDescription, parseClickUpMirrorDescription } from "./projection.js";
import { ClickUpAmbiguousWriteError, ClickUpProviderError } from "./sync.js";
import type {
  ClickUpApiPort,
  ClickUpDestinationConfig,
  ClickUpRemoteTask,
  ClickUpShadowProjection,
} from "./types.js";

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function providerError(response: Response): ClickUpProviderError {
  return new ClickUpProviderError(
    response.status === 401 || response.status === 403
      ? "clickup_credential_or_scope_rejected"
      : response.status === 429
        ? "clickup_rate_limited"
        : response.status >= 500
          ? "clickup_provider_unavailable"
          : "clickup_request_rejected",
    response.status,
    response.status === 429 || response.status >= 500,
    retryAfterMs(response),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoFromClickUp(value: unknown): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
  const parsed = new Date(String(value ?? ""));
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new ClickUpProviderError("clickup_invalid_task_timestamp", null, false, null);
}

function parseDependencyTaskIds(taskId: string, value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ClickUpProviderError("clickup_invalid_task_response", null, false, null);
  }

  const dependencyTaskIds = new Set<string>();
  for (const entry of value) {
    const dependency = asRecord(entry);
    const dependentTaskId = asString(dependency.task_id);
    const dependsOnTaskId = asString(dependency.depends_on);
    if (!dependentTaskId
      || !dependsOnTaskId
      || dependentTaskId === dependsOnTaskId
      || (dependentTaskId !== taskId && dependsOnTaskId !== taskId)) {
      throw new ClickUpProviderError("clickup_invalid_task_response", null, false, null);
    }
    if (dependentTaskId === taskId) dependencyTaskIds.add(dependsOnTaskId);
  }
  return [...dependencyTaskIds].sort();
}

function parseTask(value: unknown): ClickUpRemoteTask {
  const task = asRecord(value);
  const list = asRecord(task.list);
  const status = asRecord(task.status);
  const parent = asRecord(task.parent);
  const id = asString(task.id);
  const listId = asString(list.id);
  const title = asString(task.name);
  const statusId = asString(status.id) ?? asString(status.status);
  if (!id || !listId || !title || !statusId) {
    throw new ClickUpProviderError("clickup_invalid_task_response", null, false, null);
  }
  const customFields: Record<string, string | boolean | null | undefined> = {};
  for (const entry of Array.isArray(task.custom_fields) ? task.custom_fields : []) {
    const field = asRecord(entry);
    const id = asString(field.id);
    if (!id) continue;
    const fieldValue = field.value;
    if (typeof fieldValue === "string" || typeof fieldValue === "boolean" || fieldValue == null) {
      customFields[id] = fieldValue as string | boolean | null;
    }
  }
  const dependencyTaskIds = parseDependencyTaskIds(id, task.dependencies);
  const description = asString(task.description) ?? "";
  const descriptionIdentity = parseClickUpMirrorDescription(description);
  const assigneeIds = (Array.isArray(task.assignees) ? task.assignees : [])
    .map((entry) => Number(asRecord(entry).id))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right);
  const dueDateValue = task.due_date == null ? null : Number(task.due_date);
  const dueDateMs = dueDateValue != null && Number.isFinite(dueDateValue) ? dueDateValue : null;
  return {
    id,
    listId,
    url: asString(task.url),
    revision: asString(task.date_updated),
    title,
    description,
    correlationValue: descriptionIdentity.correlationValue,
    projectionVersion: descriptionIdentity.projectionVersion,
    statusId,
    assigneeIds,
    timeEstimateMs: task.time_estimate == null ? null : Number(task.time_estimate),
    dueDateMs,
    dueDateTime: task.due_date_time === true,
    customFields,
    parentTaskId: asString(parent.id) ?? asString(task.parent),
    dependencyTaskIds,
    updatedAt: isoFromClickUp(task.date_updated),
  };
}

export class ClickUpApiClient implements ClickUpApiPort {
  constructor(
    private readonly http: PluginContext["http"],
    private readonly config: ClickUpDestinationConfig,
    private readonly token: string,
  ) {}

  private url(path: string): URL {
    const base = new URL(this.config.apiBaseUrl.endsWith("/") ? this.config.apiBaseUrl : `${this.config.apiBaseUrl}/`);
    const target = new URL(path.replace(/^\//, ""), base);
    if (target.protocol !== "https:" || target.username || target.password || target.origin !== base.origin
      || !target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
      throw new ClickUpProviderError("clickup_target_scope_mismatch", null, false, null);
    }
    return target;
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    target: URL,
    body?: unknown,
    ambiguousMutation = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.http.fetch(target.toString(), {
        method,
        headers: {
          authorization: this.token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      if (ambiguousMutation) throw new ClickUpAmbiguousWriteError();
      throw new ClickUpProviderError("clickup_network_failure", null, true, null);
    }
    if (!response.ok) {
      if (ambiguousMutation && response.status >= 500) throw new ClickUpAmbiguousWriteError();
      throw providerError(response);
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ClickUpProviderError("clickup_invalid_json", response.status, false, null);
    }
  }

  async findTasksByCorrelation(input: {
    listId: string;
    correlationValue: string;
  }): Promise<ClickUpRemoteTask[]> {
    if (input.listId !== this.config.listId) {
      throw new ClickUpProviderError("clickup_correlation_scope_mismatch", null, false, null);
    }
    const matches: ClickUpRemoteTask[] = [];
    for (let page = 0; page < 100; page += 1) {
      const target = this.url(`list/${encodeURIComponent(input.listId)}/task`);
      target.searchParams.set("page", String(page));
      target.searchParams.set("subtasks", "true");
      target.searchParams.set("include_closed", "true");
      const payload = asRecord(await this.json(await this.request("GET", target)));
      const tasks = Array.isArray(payload.tasks) ? payload.tasks.map(parseTask) : [];
      matches.push(...tasks.filter((task) => task.correlationValue === input.correlationValue));
      if (tasks.length < 100) break;
    }
    return matches;
  }

  async getTask(taskId: string): Promise<ClickUpRemoteTask | null> {
    const target = this.url(`task/${encodeURIComponent(taskId)}`);
    target.searchParams.set("include_subtasks", "true");
    let response: Response;
    try {
      response = await this.request("GET", target);
    } catch (error) {
      if (error instanceof ClickUpProviderError && error.status === 404) return null;
      throw error;
    }
    return parseTask(await this.json(response));
  }

  async createTask(input: ClickUpShadowProjection): Promise<ClickUpRemoteTask> {
    if (input.listId !== this.config.listId) throw new ClickUpProviderError("clickup_create_scope_mismatch", null, false, null);
    const response = await this.request("POST", this.url(`list/${encodeURIComponent(input.listId)}/task`), {
      name: input.title,
      description: input.description,
      status: input.statusName,
      assignees: [input.nativeAssigneeId],
      ...(input.timeEstimateMs == null ? {} : { time_estimate: input.timeEstimateMs }),
      ...(input.dueDateMs == null ? {} : { due_date: input.dueDateMs, due_date_time: false }),
      ...(input.parentTaskId == null ? {} : { parent: input.parentTaskId }),
      notify_all: false,
      ...(Object.keys(input.customFields).length === 0 ? {} : {
        custom_fields: Object.entries(input.customFields)
          .filter((entry): entry is [string, string | boolean] => entry[1] != null)
          .map(([id, value]) => ({ id, value })),
      }),
    }, true);
    return parseTask(await this.json(response));
  }

  async updateTask(taskId: string, input: ClickUpShadowProjection): Promise<ClickUpRemoteTask> {
    const current = await this.getTask(taskId);
    if (!current) throw new ClickUpAmbiguousWriteError("clickup_update_target_missing");
    const removeAssignees = current.assigneeIds.filter((id) => id !== input.nativeAssigneeId);
    const addAssignees = current.assigneeIds.includes(input.nativeAssigneeId) ? [] : [input.nativeAssigneeId];
    await this.request("PUT", this.url(`task/${encodeURIComponent(taskId)}`), {
      name: input.title,
      description: mergeClickUpManagedDescription(current.description, input.description),
      status: input.statusName,
      time_estimate: input.timeEstimateMs,
      due_date: input.dueDateMs,
      due_date_time: false,
      assignees: { add: addAssignees, rem: removeAssignees },
    }, true);
    for (const [fieldId, value] of Object.entries(input.customFields)) {
      const target = this.url(`task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`);
      if (value == null) await this.request("DELETE", target, undefined, true);
      else await this.request("POST", target, { value }, true);
    }
    const updated = await this.getTask(taskId);
    if (!updated) throw new ClickUpAmbiguousWriteError("clickup_update_readback_missing");
    return updated;
  }

  async updateParent(taskId: string, parentTaskId: string): Promise<void> {
    await this.request("PUT", this.url(`task/${encodeURIComponent(taskId)}`), { parent: parentTaskId }, true);
  }

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.request("POST", this.url(`task/${encodeURIComponent(taskId)}/dependency`), { depends_on: dependsOnTaskId }, true);
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    const target = this.url(`task/${encodeURIComponent(taskId)}/dependency`);
    target.searchParams.set("depends_on", dependsOnTaskId);
    await this.request("DELETE", target, undefined, true);
  }
}
