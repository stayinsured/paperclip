import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clickUpConfigurationFingerprint, clickUpSha256 } from "../src/modules/clickup/identity.js";
import {
  APPROVED_CLICKUP_API_BASE_URL,
  APPROVED_CLICKUP_LIST_ID,
  APPROVED_CLICKUP_WORKSPACE_ID,
  assertClickUpModuleActivationUsable,
  ClickUpConfigurationError,
  parseClickUpModuleActivation,
} from "../src/modules/clickup/config.js";
import { shouldSuppressClickUpEcho } from "../src/modules/clickup/conflicts.js";
import { calculateClickUpProjectionHealth } from "../src/modules/clickup/health.js";
import { mergeClickUpManagedDescription, ownedSnapshotFromRemote, renderClickUpShadowProjection } from "../src/modules/clickup/projection.js";
import { acceptedClickUpDeliveryMetadata } from "../src/modules/clickup/metadata.js";
import { reconcileClickUpRelationships } from "../src/modules/clickup/relationships.js";
import {
  ClickUpAmbiguousWriteError,
  projectIssueToClickUp,
} from "../src/modules/clickup/sync.js";
import type {
  ClickUpApiPort,
  ClickUpAuthorization,
  ClickUpConflict,
  ClickUpDestinationConfig,
  ClickUpLinkRepository,
  ClickUpModuleActivation,
  ClickUpProjectionSource,
  ClickUpRemoteTask,
  ClickUpShadowProjection,
  ClickUpTaskLink,
} from "../src/modules/clickup/types.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
const proofValidNow = () => new Date("2026-08-07T11:00:00.000Z");

const config: ClickUpDestinationConfig = {
  apiBaseUrl: "https://api.clickup.example/api/v2",
  tokenSecretId: "00000000-0000-4000-8000-000000000004",
  tokenSecretVersion: 2,
  workspaceId: "workspace-1",
  spaceId: "space-1",
  listId: "list-1",
  statuses: {
    toDo: { id: "status-todo", name: "to do" },
    inProgress: { id: "status-progress", name: "in progress" },
    done: { id: "status-done", name: "done" },
  },
  ownerAssigneeId: 94656177,
};

function authorization(overrides: Partial<ClickUpAuthorization> = {}): ClickUpAuthorization {
  const fingerprint = clickUpConfigurationFingerprint(config);
  return {
    enabled: true,
    readOnly: false,
    externalWritesEnabled: true,
    intakeEnabled: false,
    exactConfigurationApproval: {
      status: "accepted",
      configurationRevisionId: "revision-approved",
      configurationFingerprint: fingerprint,
      interactionId: "interaction-approved",
      acceptedAt: "2026-08-07T09:00:00.000Z",
    },
    listAccessProof: {
      workspaceId: config.workspaceId,
      spaceId: config.spaceId,
      listId: config.listId,
      principalId: String(config.ownerAssigneeId),
      configurationFingerprint: fingerprint,
      verifiedAt: "2026-08-07T09:30:00.000Z",
      expiresAt: "2026-08-08T09:30:00.000Z",
      scope: "list_read_write",
      endpoints: {
        tasksRead: true,
        tasksCreate: true,
        tasksUpdate: true,
        dependenciesRead: true,
        dependenciesCreate: true,
        dependenciesDelete: true,
      },
    },
    ...overrides,
  };
}

function source(overrides: Partial<ClickUpProjectionSource> = {}): ClickUpProjectionSource {
  return {
    companyId,
    projectId,
    issueId,
    issueIdentifier: "STA-1843",
    issueUrl: "https://paperclip.example/STA/issues/STA-1843?token=remove-me",
    title: "Constrained ClickUp projection",
    planningSummary: "Project only approved fields for ops@example.com.",
    status: "in_review",
    assigneeDisplayRef: "Backend & Integrations Engineer",
    blockerSummary: null,
    acceptanceSummary: "Replay has one mapping; api_key=do-not-copy",
    approvedEstimate: {
      documentKey: "cto-refinement",
      revisionId: "revision-1",
      accepted: true,
      isLatestAccepted: true,
      upperBound: 2.1,
      unit: "person_days",
    },
    dueDate: "2026-09-11",
    updatedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

function projection(overrides: Partial<ClickUpProjectionSource> = {}): ClickUpShadowProjection {
  return renderClickUpShadowProjection({
    source: source(overrides),
    config,
    policyVersion: "pilot-rc3",
    generatedAt: new Date("2026-08-07T10:01:00.000Z"),
  });
}

class MemoryLinks implements ClickUpLinkRepository {
  links: ClickUpTaskLink[] = [];
  conflicts: ClickUpConflict[] = [];

  async getByIssue(targetCompanyId: string, targetIssueId: string): Promise<ClickUpTaskLink | null> {
    return this.links.find((link) => link.companyId === targetCompanyId && link.issueId === targetIssueId) ?? null;
  }

  async getByExternalTask(targetCompanyId: string, listId: string, taskId: string): Promise<ClickUpTaskLink | null> {
    return this.links.find((link) => (
      link.companyId === targetCompanyId && link.listId === listId && link.taskId === taskId
    )) ?? null;
  }

  async upsertLink(input: Omit<ClickUpTaskLink, "id">): Promise<ClickUpTaskLink> {
    const issueMatch = this.links.find((link) => link.companyId === input.companyId && link.issueId === input.issueId);
    const taskMatch = this.links.find((link) => (
      link.companyId === input.companyId && link.listId === input.listId && link.taskId === input.taskId
    ));
    if (taskMatch && issueMatch && taskMatch.id !== issueMatch.id) throw new Error("mapping uniqueness violation");
    const existing = issueMatch ?? taskMatch;
    const link = { ...input, id: existing?.id ?? randomUUID() };
    if (existing) this.links[this.links.indexOf(existing)] = link;
    else this.links.push(link);
    return link;
  }

  async recordConflicts(conflicts: ClickUpConflict[]): Promise<void> {
    for (const conflict of conflicts) {
      const existing = this.conflicts.find((candidate) => candidate.conflictKey === conflict.conflictKey);
      if (existing) Object.assign(existing, conflict);
      else this.conflicts.push(conflict);
    }
  }
}

class MemoryClickUp implements ClickUpApiPort {
  tasks = new Map<string, ClickUpRemoteTask>();
  calls: string[] = [];
  ambiguousCreate = false;
  commitAmbiguousCreate = false;
  dueDateReadbackOffsetMs = 0;
  dueDateTimeReadback = false;

  async findTasksByCorrelation(input: { listId: string; correlationValue: string }): Promise<ClickUpRemoteTask[]> {
    this.calls.push(`find:${input.correlationValue}`);
    return [...this.tasks.values()].filter((task) => (
      task.listId === input.listId && task.correlationValue === input.correlationValue
    ));
  }

  async getTask(taskId: string): Promise<ClickUpRemoteTask | null> {
    this.calls.push(`get:${taskId}`);
    return this.tasks.get(taskId) ?? null;
  }

  private fromProjection(input: ClickUpShadowProjection, id: string): ClickUpRemoteTask {
    return {
      id,
      listId: input.listId,
      url: `https://app.clickup.example/t/${id}`,
      revision: `revision-${this.calls.length}`,
      title: input.title,
      description: input.description,
      correlationValue: input.correlationValue,
      projectionVersion: input.projectionVersion,
      statusId: input.statusId,
      assigneeIds: [input.nativeAssigneeId],
      timeEstimateMs: input.timeEstimateMs,
      dueDateMs: input.dueDateMs == null ? null : input.dueDateMs + this.dueDateReadbackOffsetMs,
      dueDateTime: this.dueDateTimeReadback,
      customFields: { ...input.customFields },
      parentTaskId: input.parentTaskId,
      dependencyTaskIds: [],
      updatedAt: "2026-08-07T10:01:00.000Z",
    };
  }

  async createTask(input: ClickUpShadowProjection): Promise<ClickUpRemoteTask> {
    this.calls.push(`create:${input.issueId}`);
    const task = this.fromProjection(input, `task-${this.tasks.size + 1}`);
    if (!this.ambiguousCreate || this.commitAmbiguousCreate) this.tasks.set(task.id, task);
    if (this.ambiguousCreate) throw new ClickUpAmbiguousWriteError();
    return task;
  }

  async updateTask(taskId: string, input: ClickUpShadowProjection): Promise<ClickUpRemoteTask> {
    this.calls.push(`update:${taskId}`);
    const current = this.tasks.get(taskId);
    const task = { ...this.fromProjection(input, taskId), parentTaskId: current?.parentTaskId ?? null, dependencyTaskIds: current?.dependencyTaskIds ?? [] };
    this.tasks.set(taskId, task);
    return task;
  }

  async updateParent(taskId: string, parentTaskId: string): Promise<void> {
    this.calls.push(`parent:${taskId}:${parentTaskId}`);
    this.tasks.get(taskId)!.parentTaskId = parentTaskId;
  }

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    this.calls.push(`dependency-add:${taskId}:${dependsOnTaskId}`);
    const task = this.tasks.get(taskId)!;
    task.dependencyTaskIds = [...new Set([...task.dependencyTaskIds, dependsOnTaskId])];
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    this.calls.push(`dependency-remove:${taskId}:${dependsOnTaskId}`);
    const task = this.tasks.get(taskId)!;
    task.dependencyTaskIds = task.dependencyTaskIds.filter((id) => id !== dependsOnTaskId);
  }
}

function approvedActivation(overrides: Partial<ClickUpModuleActivation> = {}): ClickUpModuleActivation {
  const destination: ClickUpDestinationConfig = {
    ...structuredClone(config),
    apiBaseUrl: "https://api.clickup.com/api/v2/",
    workspaceId: APPROVED_CLICKUP_WORKSPACE_ID,
    listId: APPROVED_CLICKUP_LIST_ID,
  };
  const fingerprint = clickUpConfigurationFingerprint(destination);
  return {
    schemaVersion: 1,
    paperclipBaseUrl: "https://paperclip.example/DEMO/",
    tokenRef: {
      type: "secret_ref",
      secretId: destination.tokenSecretId,
      version: destination.tokenSecretVersion ?? undefined,
    },
    destination,
    authorization: {
      enabled: true,
      readOnly: false,
      externalWritesEnabled: true,
      intakeEnabled: false,
      exactConfigurationApproval: {
        status: "accepted",
        configurationRevisionId: "revision-approved",
        configurationFingerprint: fingerprint,
        interactionId: "interaction-approved",
        acceptedAt: "2026-08-28T09:00:00.000Z",
      },
      listAccessProof: {
        workspaceId: destination.workspaceId,
        spaceId: destination.spaceId,
        listId: destination.listId,
        principalId: String(destination.ownerAssigneeId),
        configurationFingerprint: fingerprint,
        verifiedAt: "2026-08-28T09:30:00.000Z",
        expiresAt: "2099-08-29T09:30:00.000Z",
        scope: "list_read_write",
        endpoints: {
          tasksRead: true,
          tasksCreate: true,
          tasksUpdate: true,
          dependenciesRead: true,
          dependenciesCreate: true,
          dependenciesDelete: true,
        },
      },
    },
    ...overrides,
  };
}

describe("ClickUp activation boundary", () => {
  it("accepts only the approved workspace/list with a managed secret reference and full proof", () => {
    const activation = approvedActivation();
    expect(parseClickUpModuleActivation(activation)).toMatchObject({
      tokenRef: { type: "secret_ref", secretId: config.tokenSecretId, version: 2 },
      destination: {
        workspaceId: APPROVED_CLICKUP_WORKSPACE_ID,
        listId: APPROVED_CLICKUP_LIST_ID,
      },
      authorization: { intakeEnabled: false },
    });
    expect(JSON.stringify(activation)).not.toContain("Bearer ");
  });

  it("fails closed outside the approved boundary or when reverse intake is enabled", () => {
    const outside = approvedActivation();
    outside.destination.workspaceId = "other-workspace";
    const fingerprint = clickUpConfigurationFingerprint(outside.destination);
    outside.authorization.exactConfigurationApproval!.configurationFingerprint = fingerprint;
    outside.authorization.listAccessProof = {
      ...outside.authorization.listAccessProof!,
      workspaceId: outside.destination.workspaceId,
      configurationFingerprint: fingerprint,
    };
    expect(() => assertClickUpModuleActivationUsable(outside, proofValidNow())).toThrowError(
      expect.objectContaining({ code: "clickup_destination_outside_approved_boundary" }),
    );
    const wrongApi = approvedActivation();
    wrongApi.destination.apiBaseUrl = "https://proxy.example/api/v2";
    expect(() => assertClickUpModuleActivationUsable(wrongApi, proofValidNow())).toThrowError(
      expect.objectContaining({ code: "clickup_api_url_outside_approved_boundary" }),
    );
    expect(APPROVED_CLICKUP_API_BASE_URL).toBe("https://api.clickup.com/api/v2");
    const reboundSecret = approvedActivation();
    reboundSecret.tokenRef.secretId = "other-managed-secret";
    expect(() => assertClickUpModuleActivationUsable(reboundSecret, proofValidNow())).toThrowError(
      expect.objectContaining({ code: "clickup_secret_ref_destination_mismatch" }),
    );
    const intake = approvedActivation();
    intake.authorization.intakeEnabled = true;
    expect(() => assertClickUpModuleActivationUsable(intake, proofValidNow())).toThrowError(
      expect.objectContaining({ code: "clickup_reverse_intake_not_approved" }),
    );
  });
});

describe("ClickUp planning metadata", () => {
  it("accepts the explicit bootstrap QA metadata and fails closed when it is malformed", () => {
    const issueType = {
      description: [
        "Validate the synthetic DAG.",
        "",
        "## Planning metadata",
        "",
        "- Upper-bound effort: 4 hours. QA/review P90 active time is 0.92h.",
        "- Forecast: 2026-09-01. Calibration revision: 2026-08-27. External work remains fail-closed.",
      ].join("\n"),
      parentId: "parent-issue",
    } as Parameters<typeof acceptedClickUpDeliveryMetadata>[0]["issue"];
    expect(acceptedClickUpDeliveryMetadata({ issue: issueType, planDocument: null, interactions: [] })).toMatchObject({
      dueDate: "2026-09-01",
      approvedEstimate: {
        documentKey: "cto-refinement",
        revisionId: "2026-08-27",
        upperBound: 4,
        unit: "hours",
      },
    });

    const malformed = { ...issueType, description: "## Planning metadata\n\n- Upper-bound effort: four hours." };
    expect(acceptedClickUpDeliveryMetadata({ issue: malformed, planDocument: null, interactions: [] })).toMatchObject({
      approvedEstimate: null,
      dueDate: null,
    });
  });

  it("accepts only provisioned estimates bound to the latest accepted parent plan revision", () => {
    const parentId = "parent-issue";
    const issueType = {
      parentId,
      description: [
        "Provisioned from STA-2762 approved plan revision 1 (Gate 1 accepted 2026-08-28).",
        "Planned owner: Backend and Integrations Engineer.",
        "Estimate: 3 person-days; due 2026-09-11.",
      ].join("\n"),
    } as Parameters<typeof acceptedClickUpDeliveryMetadata>[0]["issue"];
    const planDocument = {
      latestRevisionNumber: 1,
      latestRevisionId: "accepted-plan-revision",
    } as NonNullable<Parameters<typeof acceptedClickUpDeliveryMetadata>[0]["planDocument"]>;
    const interaction = {
      kind: "request_confirmation",
      status: "accepted",
      payload: {
        target: {
          type: "issue_document",
          issueId: parentId,
          key: "plan",
          revisionId: "accepted-plan-revision",
          revisionNumber: 1,
        },
      },
    } as Parameters<typeof acceptedClickUpDeliveryMetadata>[0]["interactions"][number];

    expect(acceptedClickUpDeliveryMetadata({ issue: issueType, planDocument, interactions: [interaction] })).toMatchObject({
      plannedOwner: "Backend and Integrations Engineer",
      dueDate: "2026-09-11",
      approvedEstimate: {
        documentKey: "plan",
        revisionId: "accepted-plan-revision",
        upperBound: 3,
        unit: "person_days",
      },
    });
  });
});

describe("ClickUp exact configuration and shadow projection", () => {
  it("projects only native fields and the managed description block", async () => {
    const result = projection();
    expect(result).toMatchObject({
      mode: "shadow",
      wouldWrite: false,
      title: "[STA-1843] Constrained ClickUp projection",
      statusId: config.statuses.inProgress.id,
      statusName: "in progress",
      nativeAssigneeId: 94656177,
      timeEstimateMs: 20 * 60 * 60 * 1_000,
      dueDateMs: Date.parse("2026-09-11T00:00:00.000Z"),
      customFields: {},
    });
    expect(result.description).toMatch(/^<!-- paperclip-sync:start -->\n/);
    expect(result.description).toMatch(/\n<!-- paperclip-sync:end -->$/);
    expect(result.description).not.toContain("paperclip:clickup-mirror");
    expect(result.description).toContain("Paperclip status: in_review");
    expect(result.description).toContain("Forecast source: cto-refinement");
    expect(result.description).toContain("Forecast revision: revision-1");
    expect(result.description).toContain("[redacted-email]");
    expect(result.description).toContain("api_key=[redacted]");
    expect(result.correlationValue).not.toContain("token=remove-me");
    const readback = await new MemoryClickUp().createTask(result);
    expect(ownedSnapshotFromRemote(readback, config)).toEqual(result.ownedSnapshot);
  });

  it("fails closed when accepted forecast metadata is absent", () => {
    expect(() => projection({ approvedEstimate: null })).toThrowError(
      expect.objectContaining({ code: "clickup_planning_metadata_invalid" }),
    );
    expect(() => projection({ dueDate: null })).toThrowError(
      expect.objectContaining({ code: "clickup_planning_metadata_invalid" }),
    );
  });

  it("uses exactly three projection targets and never retains the prior lane for blocked", () => {
    const mappings: Array<[ClickUpProjectionSource["status"], string]> = [
      ["backlog", config.statuses.toDo.id],
      ["todo", config.statuses.toDo.id],
      ["blocked", config.statuses.toDo.id],
      ["in_progress", config.statuses.inProgress.id],
      ["in_review", config.statuses.inProgress.id],
      ["done", config.statuses.done.id],
      ["cancelled", config.statuses.done.id],
    ];
    for (const [status, expectedStatusId] of mappings) {
      expect(projection({ status, blockerSummary: status === "blocked" ? "Waiting on STA-2802" : null }).statusId).toBe(expectedStatusId);
    }
    expect(() => projection({ status: "unknown" as ClickUpProjectionSource["status"] })).toThrowError(
      expect.objectContaining({ code: "clickup_paperclip_status_unmapped" }),
    );
    const mismatched = structuredClone(config);
    mismatched.statuses.done.name = "complete";
    expect(() => renderClickUpShadowProjection({
      source: source(), config: mismatched, policyVersion: "pilot-rc3",
    })).toThrowError(expect.objectContaining({ code: "clickup_done_status_name_mismatch" }));
  });

  it("preserves all text outside the managed description block", () => {
    const current = projection({ status: "in_progress" });
    const existing = `Human preface\n\n${current.description}\n\nHuman footer`;
    const updated = projection({ status: "done" });
    const merged = mergeClickUpManagedDescription(existing, updated.description);
    expect(merged).toMatch(/^Human preface/);
    expect(merged).toMatch(/Human footer$/);
    expect(merged).toContain("Paperclip status: done");
    expect(merged.match(/<!-- paperclip-sync:start -->/g)).toHaveLength(1);
    expect(merged.match(/<!-- paperclip-sync:end -->/g)).toHaveLength(1);
  });

  it("rejects malformed managed description markers", () => {
    const managed = projection().description;
    expect(() => mergeClickUpManagedDescription(
      "Human preface\n\n<!-- paperclip-sync:start -->\nstale managed text",
      managed,
    )).toThrowError(expect.objectContaining({ code: "clickup_managed_description_ambiguous" }));
    expect(() => mergeClickUpManagedDescription(
      "<!-- paperclip-sync:end -->\nstale managed text\n<!-- paperclip-sync:start -->",
      managed,
    )).toThrowError(expect.objectContaining({ code: "clickup_managed_description_ambiguous" }));
  });

  it("rejects duplicate managed description blocks", () => {
    const managed = projection().description;
    expect(() => mergeClickUpManagedDescription(
      managed + "\n\nHuman text\n\n" + managed,
      managed,
    )).toThrowError(expect.objectContaining({ code: "clickup_managed_description_ambiguous" }));
  });
});

describe("ClickUp projection replay, echo suppression, and conflicts", () => {
  it("keeps provider access impossible while shadow/read-only mode is active", async () => {
    const api = new MemoryClickUp();
    await expect(projectIssueToClickUp({
      projection: projection(), config, authorization: authorization({ readOnly: true }),
      api, repository: new MemoryLinks(), now: new Date("2026-08-07T11:00:00.000Z"),
    })).rejects.toEqual(expect.objectContaining({ code: "clickup_external_writes_disabled" }));
    expect(api.calls).toEqual([]);
  });

  it("creates exactly one task and one mapping across replay", async () => {
    const api = new MemoryClickUp();
    const repository = new MemoryLinks();
    const input = {
      projection: projection(), config, authorization: authorization(), api, repository,
      now: new Date("2026-08-07T11:00:00.000Z"),
    };
    const first = await projectIssueToClickUp(input);
    const replay = await projectIssueToClickUp(input);
    expect(first).toMatchObject({ action: "created", outcome: "succeeded", errorClass: null });
    expect(replay.action).toBe("already_current");
    expect(api.tasks).toHaveLength(1);
    expect(repository.links).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(api.calls.filter((call) => call === "get:task-1").length).toBeGreaterThanOrEqual(2);
  });

  it("compares the observed date-only readback by its calendar date", async () => {
    const api = new MemoryClickUp();
    const repository = new MemoryLinks();
    api.dueDateReadbackOffsetMs = 2 * 60 * 60 * 1_000;
    const expected = projection({ dueDate: "2026-09-04" });
    const input = {
      projection: expected, config, authorization: authorization(), api, repository,
      now: proofValidNow(),
    };

    const first = await projectIssueToClickUp(input);
    const replay = await projectIssueToClickUp(input);

    expect(expected.dueDateMs).toBe(1788480000000);
    expect(api.tasks.get("task-1")?.dueDateMs).toBe(1788487200000);
    expect(first).toMatchObject({ action: "created", outcome: "succeeded", errorClass: null });
    expect(replay).toMatchObject({ action: "already_current", outcome: "succeeded", errorClass: null });
    api.tasks.get("task-1")!.dueDateMs = 1788487200000 + 24 * 60 * 60 * 1_000;
    const drift = await projectIssueToClickUp(input);

    expect(drift).toMatchObject({ action: "conflict", outcome: "conflict" });
    expect(repository.conflicts.map((conflict) => conflict.field)).toContain("dueDate");

    expect(repository.links).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith("update:"))).toHaveLength(0);
  });

  it("preserves null and strict timed due-date values at the remote boundary", async () => {
    const readback = await new MemoryClickUp().createTask(projection({ dueDate: "2026-09-04" }));

    expect(ownedSnapshotFromRemote({ ...readback, dueDateMs: null }, config).dueDate).toBeNull();
    expect(ownedSnapshotFromRemote({
      ...readback,
      dueDateMs: 1788487200000,
      dueDateTime: true,
    }, config).dueDate).toBe(1788487200000);
    expect(ownedSnapshotFromRemote({
      ...readback,
      dueDateMs: 1788487200000,
      dueDateTime: false,
    }, config).dueDate).toBe("2026-09-04");
  });

  it("reconciles an ambiguous create by stable correlation before retry", async () => {
    const api = new MemoryClickUp();
    const repository = new MemoryLinks();
    api.ambiguousCreate = true;
    api.commitAmbiguousCreate = true;
    const result = await projectIssueToClickUp({
      projection: projection(), config, authorization: authorization(), api, repository,
      now: new Date("2026-08-07T11:00:00.000Z"),
    });
    expect(result.action).toBe("already_current");
    expect(result.reconciledBeforeRetry).toBe(true);
    expect(api.tasks).toHaveLength(1);
    expect(repository.links).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

  it("suppresses service-account and projected-version echoes", async () => {
    const api = new MemoryClickUp();
    const repository = new MemoryLinks();
    await projectIssueToClickUp({
      projection: projection(), config, authorization: authorization(), api, repository,
      now: new Date("2026-08-07T11:00:00.000Z"),
    });
    const link = repository.links[0]!;
    expect(shouldSuppressClickUpEcho({
      taskId: link.taskId,
      listId: link.listId,
      actorId: "service-account",
      connectorServiceAccountId: "service-account",
      projectionVersion: null,
    }, link)).toBe(true);
    expect(shouldSuppressClickUpEcho({
      taskId: link.taskId,
      listId: link.listId,
      actorId: "human",
      connectorServiceAccountId: "service-account",
      projectionVersion: link.lastProjectionVersion,
    }, link)).toBe(true);
  });

  it("records concurrent ClickUp edits as visible conflicts without overwriting", async () => {
    const api = new MemoryClickUp();
    const repository = new MemoryLinks();
    const initial = projection();
    await projectIssueToClickUp({
      projection: initial, config, authorization: authorization(), api, repository,
      now: new Date("2026-08-07T11:00:00.000Z"),
    });
    const task = [...api.tasks.values()][0]!;
    task.title = "Human changed remote title";
    task.updatedAt = "2026-08-07T11:01:00.000Z";
    const concurrentPaperclip = projection({ title: "Paperclip changed canonical title", updatedAt: "2026-08-07T11:02:00.000Z" });
    const result = await projectIssueToClickUp({
      projection: concurrentPaperclip, config, authorization: authorization(), api, repository,
      now: new Date("2026-08-07T11:03:00.000Z"),
    });
    expect(result.outcome).toBe("conflict");
    expect(repository.conflicts.map((conflict) => conflict.field)).toContain("title");
    expect(api.calls.filter((call) => call.startsWith("update:"))).toHaveLength(0);
    expect(task.title).toBe("Human changed remote title");
  });
});

describe("ClickUp hierarchy and native dependencies", () => {
  it("repairs relationship drift once and proves idempotency by readback", async () => {
    const api = new MemoryClickUp();
    const repository = new MemoryLinks();
    const parentProjection = projection({ issueId: "parent-issue", issueIdentifier: "DEMO-1" });
    const childProjection = projection({ issueId: "child-issue", issueIdentifier: "DEMO-2" });
    const blockerProjection = projection({ issueId: "blocker-issue", issueIdentifier: "DEMO-3" });
    for (const item of [parentProjection, childProjection, blockerProjection]) {
      await projectIssueToClickUp({
        projection: item,
        config,
        authorization: authorization(),
        api,
        repository,
        now: proofValidNow(),
      });
    }
    const parent = repository.links.find((link) => link.issueId === "parent-issue")!;
    const child = repository.links.find((link) => link.issueId === "child-issue")!;
    const blocker = repository.links.find((link) => link.issueId === "blocker-issue")!;
    api.tasks.get(child.taskId)!.dependencyTaskIds = [parent.taskId, "external-dependency"];
    const input = {
      api,
      config,
      taskId: child.taskId,
      correlationValue: childProjection.correlationValue,
      desiredParentTaskId: parent.taskId,
      desiredDependencyTaskIds: [blocker.taskId],
      managedDependencyTaskIds: [parent.taskId, child.taskId, blocker.taskId],
    };
    const repaired = await reconcileClickUpRelationships(input);
    const replay = await reconcileClickUpRelationships(input);
    expect(repaired).toEqual({ action: "updated", writes: 3 });
    expect(replay).toEqual({ action: "already_current", writes: 0 });
    expect(api.tasks.get(child.taskId)).toMatchObject({
      parentTaskId: parent.taskId,
      dependencyTaskIds: ["external-dependency", blocker.taskId],
    });
  });
});

describe("ClickUp health", () => {
  it("calculates p95 freshness and emits one stable visible lag exception above 15 minutes", () => {
    const healthy = calculateClickUpProjectionHealth({
      companyId,
      listId: config.listId,
      timings: [
        { sourceUpdatedAt: "2026-08-07T10:00:00.000Z", projectedAt: "2026-08-07T10:01:00.000Z" },
        { sourceUpdatedAt: "2026-08-07T10:00:00.000Z", projectedAt: "2026-08-07T10:04:00.000Z" },
      ],
      now: new Date("2026-08-07T10:04:00.000Z"),
    });
    expect(healthy.p95FreshnessMs).toBe(4 * 60 * 1_000);
    expect(healthy.exception).toBeNull();

    const lagging = calculateClickUpProjectionHealth({
      companyId,
      listId: config.listId,
      timings: [{ sourceUpdatedAt: "2026-08-07T10:00:00.000Z", projectedAt: null }],
      now: new Date("2026-08-07T10:16:00.001Z"),
    });
    expect(lagging.status).toBe("degraded");
    expect(lagging.exception).toEqual(expect.objectContaining({
      kind: "projection_lag",
      exceptionKey: `clickup-lag:${clickUpSha256(`${companyId}\u0000${config.listId}`)}`,
    }));
  });
});
