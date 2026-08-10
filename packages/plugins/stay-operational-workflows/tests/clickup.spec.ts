import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clickUpConfigurationFingerprint, clickUpSha256 } from "../src/modules/clickup/identity.js";
import { ClickUpConfigurationError } from "../src/modules/clickup/config.js";
import { shouldSuppressClickUpEcho } from "../src/modules/clickup/conflicts.js";
import { calculateClickUpProjectionHealth } from "../src/modules/clickup/health.js";
import { renderClickUpShadowProjection } from "../src/modules/clickup/projection.js";
import {
  ClickUpAmbiguousWriteError,
  intakeClickUpTask,
  projectIssueToClickUp,
} from "../src/modules/clickup/sync.js";
import type {
  ClickUpApiPort,
  ClickUpAuthorization,
  ClickUpConflict,
  ClickUpDestinationConfig,
  ClickUpIntakeCandidate,
  ClickUpLinkRepository,
  ClickUpProjectionSource,
  ClickUpRemoteTask,
  ClickUpShadowProjection,
  ClickUpTaskLink,
  PaperclipIssueIntakePort,
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
    readyForQa: { id: "status-qa", name: "ready for qa" },
    complete: { id: "status-complete", name: "complete" },
  },
  fields: {
    paperclipIssueId: "field-identity",
    planningSummary: "field-summary",
    assigneeDisplay: "field-assignee",
    blocker: "field-blocker",
    acceptanceSummary: "field-acceptance",
    estimateNeeded: "field-estimate-needed",
    projectionVersion: "field-projection-version",
    intakeOptIn: "field-intake",
  },
  intakeOptInValue: "import-to-paperclip",
};

function authorization(overrides: Partial<ClickUpAuthorization> = {}): ClickUpAuthorization {
  const fingerprint = clickUpConfigurationFingerprint(config);
  return {
    enabled: true,
    readOnly: false,
    externalWritesEnabled: true,
    intakeEnabled: true,
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
      principalId: "clickup-principal-1",
      configurationFingerprint: fingerprint,
      verifiedAt: "2026-08-07T09:30:00.000Z",
      expiresAt: "2026-08-08T09:30:00.000Z",
      scope: "list_read_write",
      endpoints: { tasksRead: true, tasksCreate: true, tasksUpdate: true, customFieldsRead: true },
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

  async findTasksByCorrelation(input: { listId: string; correlationFieldId: string; correlationValue: string }): Promise<ClickUpRemoteTask[]> {
    this.calls.push(`find:${input.correlationValue}`);
    return [...this.tasks.values()].filter((task) => (
      task.listId === input.listId && task.customFields[input.correlationFieldId] === input.correlationValue
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
      statusId: input.statusId,
      timeEstimateMs: input.timeEstimateMs,
      customFields: { ...input.customFields },
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
    const task = this.fromProjection(input, taskId);
    this.tasks.set(taskId, task);
    return task;
  }
}

describe("ClickUp exact configuration and shadow projection", () => {
  it("projects only the allowlisted fields, exact ready-for-QA status, and conservative upper estimate", () => {
    const result = projection();
    expect(result.mode).toBe("shadow");
    expect(result.wouldWrite).toBe(false);
    expect(result.statusId).toBe("status-qa");
    expect(result.statusName).toBe("ready for qa");
    expect(result.timeEstimateMs).toBe(20 * 60 * 60 * 1_000);
    expect(result.customFields[config.fields.estimateNeeded]).toBe(false);
    expect(result.customFields[config.fields.planningSummary]).toContain("[redacted-email]");
    expect(result.customFields[config.fields.acceptanceSummary]).toContain("api_key=[redacted]");
    expect(result.correlationValue).not.toContain("token=remove-me");
    expect(Object.keys(result.customFields).sort()).toEqual([
      config.fields.acceptanceSummary,
      config.fields.assigneeDisplay,
      config.fields.blocker,
      config.fields.estimateNeeded,
      config.fields.paperclipIssueId,
      config.fields.planningSummary,
      config.fields.projectionVersion,
    ].sort());
    expect(result).not.toHaveProperty("comments");
    expect(result).not.toHaveProperty("attachments");
    expect(result).not.toHaveProperty("watchers");
    expect(result).not.toHaveProperty("delete");
  });

  it("leaves estimate unset when no accepted structured estimate exists", () => {
    const result = projection({ approvedEstimate: null });
    expect(result.timeEstimateMs).toBeNull();
    expect(result.customFields[config.fields.estimateNeeded]).toBe(true);
  });

  it("fails closed for unknown source state and a non-uniform ready-for-QA map", () => {
    expect(() => projection({ status: "cancelled" })).toThrowError(
      expect.objectContaining({ code: "clickup_paperclip_status_unmapped" }),
    );
    const mismatched = structuredClone(config);
    mismatched.statuses.readyForQa.name = "review";
    expect(() => renderClickUpShadowProjection({
      source: source(), config: mismatched, policyVersion: "pilot-rc3",
    })).toThrowError(expect.objectContaining({ code: "clickup_readyForQa_status_name_mismatch" }));
  });

  it("retains the previous projected lane for blocked work and requires a blocker summary", () => {
    const blocked = renderClickUpShadowProjection({
      source: source({ status: "blocked", blockerSummary: "Waiting for exact list proof" }),
      config,
      policyVersion: "pilot-rc3",
      previousProjectedStatusId: config.statuses.inProgress.id,
    });
    expect(blocked.statusId).toBe(config.statuses.inProgress.id);
    expect(() => renderClickUpShadowProjection({
      source: source({ status: "blocked", blockerSummary: null }),
      config,
      policyVersion: "pilot-rc3",
      previousProjectedStatusId: config.statuses.inProgress.id,
    })).toThrowError(expect.objectContaining({ code: "clickup_blocked_summary_missing" }));
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
    expect(first.action).toBe("created");
    expect(replay.action).toBe("already_current");
    expect(api.tasks).toHaveLength(1);
    expect(repository.links).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
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

describe("ClickUp opt-in intake and health", () => {
  function candidate(overrides: Partial<ClickUpIntakeCandidate> = {}): ClickUpIntakeCandidate {
    return {
      workspaceId: config.workspaceId,
      spaceId: config.spaceId,
      listId: config.listId,
      taskId: "external-task-1",
      taskUrl: "https://app.clickup.example/t/external-task-1",
      title: "Explicitly opted-in work",
      planningSummary: "Synthetic planning input",
      statusId: config.statuses.toDo.id,
      revision: "external-revision-1",
      customFields: { [config.fields.intakeOptIn!]: config.intakeOptInValue },
      ...overrides,
    };
  }

  class MemoryIssues implements PaperclipIssueIntakePort {
    byKey = new Map<string, { issueId: string; issueIdentifier: string; issueUrl: string }>();

    async createIssue(input: Parameters<PaperclipIssueIntakePort["createIssue"]>[0]) {
      const existing = this.byKey.get(input.idempotencyKey);
      if (existing) return existing;
      const created = {
        issueId: `issue-${this.byKey.size + 1}`,
        issueIdentifier: `STA-${2000 + this.byKey.size}`,
        issueUrl: `https://paperclip.example/STA/issues/STA-${2000 + this.byKey.size}`,
      };
      this.byKey.set(input.idempotencyKey, created);
      return created;
    }
  }

  it("keeps intake disabled without the separate activation switch", async () => {
    await expect(intakeClickUpTask({
      companyId, projectId, candidate: candidate(), config,
      authorization: authorization({ intakeEnabled: false }),
      issues: new MemoryIssues(), repository: new MemoryLinks(),
      now: proofValidNow(),
    })).rejects.toEqual(expect.objectContaining({ code: "clickup_intake_disabled" }));
  });

  it("skips outside-list and missing-opt-in tasks without creating Paperclip work", async () => {
    const issues = new MemoryIssues();
    const repository = new MemoryLinks();
    const outside = await intakeClickUpTask({
      companyId, projectId, candidate: candidate({ listId: "other-list" }), config,
      authorization: authorization(), issues, repository,
      now: proofValidNow(),
    });
    const unmarked = await intakeClickUpTask({
      companyId, projectId, candidate: candidate({ customFields: {} }), config,
      authorization: authorization(), issues, repository,
      now: proofValidNow(),
    });
    expect(outside).toMatchObject({ action: "skipped", reason: "outside_approved_clickup_boundary" });
    expect(unmarked).toMatchObject({ action: "skipped", reason: "intake_opt_in_missing" });
    expect(issues.byKey).toHaveLength(0);
    expect(repository.links).toHaveLength(0);
  });

  it("creates one Paperclip issue and mapping across repeated opted-in intake", async () => {
    const issues = new MemoryIssues();
    const repository = new MemoryLinks();
    const input = {
      companyId, projectId, candidate: candidate(), config, authorization: authorization(), issues, repository,
      now: proofValidNow(),
    };
    const first = await intakeClickUpTask(input);
    const replay = await intakeClickUpTask(input);
    expect(first.action).toBe("created");
    expect(replay.action).toBe("already_linked");
    expect(issues.byKey).toHaveLength(1);
    expect(repository.links).toHaveLength(1);
    expect(repository.links[0]!.originSide).toBe("clickup");
  });

  it("fails closed on unknown intake status", async () => {
    await expect(intakeClickUpTask({
      companyId, projectId, candidate: candidate({ statusId: "unknown" }), config,
      authorization: authorization(), issues: new MemoryIssues(), repository: new MemoryLinks(),
      now: proofValidNow(),
    })).rejects.toEqual(expect.objectContaining({ code: "clickup_intake_status_unmapped" }));
  });

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
