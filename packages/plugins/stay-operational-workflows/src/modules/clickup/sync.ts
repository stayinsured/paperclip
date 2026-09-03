import { randomUUID } from "node:crypto";
import {
  assertClickUpIntakeAuthorized,
  assertClickUpProjectionAuthorized,
  ClickUpConfigurationError,
} from "./config.js";
import { detectClickUpOwnedFieldConflicts } from "./conflicts.js";
import { clickUpIntakeKey, clickUpSha256 } from "./identity.js";
import { ownedSnapshotFromRemote, redactClickUpText } from "./projection.js";
import { selectClickUpWeeklySprints } from "./sprints.js";
import type {
  ClickUpApiPort,
  ClickUpAuthorization,
  ClickUpDestinationConfig,
  ClickUpIntakeCandidate,
  ClickUpLinkRepository,
  ClickUpSprintRepository,
  ClickUpOwnedSnapshot,
  ClickUpRemoteTask,
  ClickUpShadowProjection,
  ClickUpTaskLink,
  PaperclipIssueIntakePort,
} from "./types.js";

export class ClickUpAmbiguousWriteError extends Error {
  constructor(public readonly code = "clickup_ambiguous_write") {
    super(code);
    this.name = "ClickUpAmbiguousWriteError";
  }
}

export class ClickUpProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null,
  ) {
    super(code);
    this.name = "ClickUpProviderError";
  }
}

export interface ClickUpProjectionReceipt {
  schemaVersion: 1;
  companyId: string;
  issueId: string;
  listId: string;
  taskId: string | null;
  projectionVersion: string;
  action: "created" | "updated" | "already_current" | "conflict" | "failed";
  outcome: "succeeded" | "retryable_failure" | "terminal_failure" | "conflict";
  errorClass: string | null;
  conflictCount: number;
  reconciledBeforeRetry: boolean;
  sourceIssueMutation: "none";
  occurredAt: string;
}

function receipt(
  projection: ClickUpShadowProjection,
  fields: Omit<ClickUpProjectionReceipt, "schemaVersion" | "companyId" | "issueId" | "listId" | "projectionVersion" | "sourceIssueMutation" | "occurredAt"> & {
    occurredAt?: Date;
  },
): ClickUpProjectionReceipt {
  const { occurredAt, ...rest } = fields;
  return {
    schemaVersion: 1,
    companyId: projection.companyId,
    issueId: projection.issueId,
    listId: projection.listId,
    projectionVersion: projection.projectionVersion,
    sourceIssueMutation: "none",
    occurredAt: (occurredAt ?? new Date()).toISOString(),
    ...rest,
  };
}

function stableSnapshot(snapshot: ClickUpOwnedSnapshot): string {
  return JSON.stringify(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)));
}

function remoteMatchesProjection(
  remote: ClickUpRemoteTask,
  projection: ClickUpShadowProjection,
  config: ClickUpDestinationConfig,
): boolean {
  if (remote.listId !== projection.listId) return false;
  if (remote.correlationValue !== projection.correlationValue) return false;
  const remoteSnapshot = ownedSnapshotFromRemote(remote, config);
  return stableSnapshot(remoteSnapshot) === stableSnapshot(projection.ownedSnapshot)
    && remote.projectionVersion === projection.projectionVersion;
}

async function storeHealthyLink(input: {
  repository: ClickUpLinkRepository;
  existing: ClickUpTaskLink | null;
  projection: ClickUpShadowProjection;
  remote: ClickUpRemoteTask;
  originSide: "paperclip" | "clickup";
  projectedAt: Date;
}): Promise<ClickUpTaskLink> {
  return input.repository.upsertLink({
    companyId: input.projection.companyId,
    projectId: input.projection.projectId,
    issueId: input.projection.issueId,
    listId: input.projection.listId,
    taskId: input.remote.id,
    taskUrl: input.remote.url ? redactClickUpText(input.remote.url) : null,
    originSide: input.existing?.originSide ?? input.originSide,
    correlationValueHash: clickUpSha256(input.projection.correlationValue),
    baseSnapshot: input.projection.ownedSnapshot,
    lastProjectionVersion: input.projection.projectionVersion,
    lastExternalRevision: input.remote.revision,
    status: "healthy",
    lastProjectedAt: input.projectedAt.toISOString(),
    lastReconciledAt: input.projectedAt.toISOString(),
  });
}

async function reconcileAmbiguousCreate(input: {
  api: ClickUpApiPort;
  repository: ClickUpLinkRepository;
  projection: ClickUpShadowProjection;
  config: ClickUpDestinationConfig;
  now: Date;
}): Promise<ClickUpProjectionReceipt> {
  const matches = await input.api.findTasksByCorrelation({
    listId: input.projection.listId,
    correlationValue: input.projection.correlationValue,
  });
  if (matches.length === 1 && remoteMatchesProjection(matches[0]!, input.projection, input.config)) {
    await storeHealthyLink({
      repository: input.repository,
      existing: null,
      projection: input.projection,
      remote: matches[0]!,
      originSide: "paperclip",
      projectedAt: input.now,
    });
    return receipt(input.projection, {
      taskId: matches[0]!.id,
      action: "already_current",
      outcome: "succeeded",
      errorClass: null,
      conflictCount: 0,
      reconciledBeforeRetry: true,
      occurredAt: input.now,
    });
  }
  return receipt(input.projection, {
    taskId: matches.length === 1 ? matches[0]!.id : null,
    action: "failed",
    outcome: matches.length > 1 ? "terminal_failure" : "retryable_failure",
    errorClass: matches.length > 1 ? "clickup_duplicate_correlation" : "clickup_ambiguous_write",
    conflictCount: 0,
    reconciledBeforeRetry: true,
    occurredAt: input.now,
  });
}

export async function projectIssueToClickUp(input: {
  projection: ClickUpShadowProjection;
  config: ClickUpDestinationConfig;
  authorization: ClickUpAuthorization;
  api: ClickUpApiPort;
  repository: ClickUpLinkRepository;
  now?: Date;
}): Promise<ClickUpProjectionReceipt> {
  const now = input.now ?? new Date();
  assertClickUpProjectionAuthorized({
    projection: input.projection,
    config: input.config,
    authorization: input.authorization,
    now,
  });

  let link = await input.repository.getByIssue(input.projection.companyId, input.projection.issueId);
  if (link && (link.projectId !== input.projection.projectId || link.listId !== input.projection.listId)) {
    throw new ClickUpConfigurationError("clickup_existing_link_scope_mismatch");
  }

  if (!link) {
    const correlated = await input.api.findTasksByCorrelation({
      listId: input.projection.listId,
      correlationValue: input.projection.correlationValue,
    });
    if (correlated.length > 1) {
      return receipt(input.projection, {
        taskId: null,
        action: "failed",
        outcome: "terminal_failure",
        errorClass: "clickup_duplicate_correlation",
        conflictCount: 0,
        reconciledBeforeRetry: true,
        occurredAt: now,
      });
    }
    if (correlated.length === 1) {
      const remote = correlated[0]!;
      link = await input.repository.upsertLink({
        companyId: input.projection.companyId,
        projectId: input.projection.projectId,
        issueId: input.projection.issueId,
        listId: input.projection.listId,
        taskId: remote.id,
        taskUrl: remote.url ? redactClickUpText(remote.url) : null,
        originSide: "paperclip",
        correlationValueHash: clickUpSha256(input.projection.correlationValue),
        baseSnapshot: input.projection.ownedSnapshot,
        lastProjectionVersion: input.projection.projectionVersion,
        lastExternalRevision: remote.revision,
        status: "healthy",
        lastProjectedAt: null,
        lastReconciledAt: now.toISOString(),
      });
    } else {
      try {
        const created = await input.api.createTask(input.projection);
        const readback = await input.api.getTask(created.id);
        if (!readback || !remoteMatchesProjection(readback, input.projection, input.config)) {
          return reconcileAmbiguousCreate({ ...input, now });
        }
        await storeHealthyLink({
          repository: input.repository,
          existing: null,
          projection: input.projection,
          remote: readback,
          originSide: "paperclip",
          projectedAt: now,
        });
        return receipt(input.projection, {
          taskId: readback.id,
          action: "created",
          outcome: "succeeded",
          errorClass: null,
          conflictCount: 0,
          reconciledBeforeRetry: false,
          occurredAt: now,
        });
      } catch (error) {
        if (error instanceof ClickUpAmbiguousWriteError) {
          return reconcileAmbiguousCreate({ ...input, now });
        }
        const provider = error instanceof ClickUpProviderError ? error : null;
        return receipt(input.projection, {
          taskId: null,
          action: "failed",
          outcome: provider?.retryable ? "retryable_failure" : "terminal_failure",
          errorClass: provider?.code ?? "clickup_create_failed",
          conflictCount: 0,
          reconciledBeforeRetry: false,
          occurredAt: now,
        });
      }
    }
  }

  const remote = await input.api.getTask(link.taskId);
  if (!remote) {
    return receipt(input.projection, {
      taskId: link.taskId,
      action: "conflict",
      outcome: "conflict",
      errorClass: "clickup_external_task_missing",
      conflictCount: 1,
      reconciledBeforeRetry: false,
      occurredAt: now,
    });
  }
  const remoteCorrelation = remote.correlationValue;
  if (
    remote.listId !== input.config.listId ||
    remoteCorrelation !== input.projection.correlationValue
  ) {
    return receipt(input.projection, {
      taskId: link.taskId,
      action: "conflict",
      outcome: "conflict",
      errorClass: "clickup_remote_identity_mismatch",
      conflictCount: 1,
      reconciledBeforeRetry: false,
      occurredAt: now,
    });
  }

  const externalSnapshot = ownedSnapshotFromRemote(remote, input.config);
  const conflicts = detectClickUpOwnedFieldConflicts({
    link,
    external: externalSnapshot,
    paperclip: input.projection.ownedSnapshot,
    externalUpdatedAt: remote.updatedAt,
    paperclipUpdatedAt: input.projection.sourceUpdatedAt,
    detectedAt: now,
  });
  if (conflicts.length > 0) {
    await input.repository.recordConflicts(conflicts);
    await input.repository.upsertLink({
      ...link,
      status: "conflict",
      lastExternalRevision: remote.revision,
      lastReconciledAt: now.toISOString(),
    });
    return receipt(input.projection, {
      taskId: link.taskId,
      action: "conflict",
      outcome: "conflict",
      errorClass: "clickup_owned_field_conflict",
      conflictCount: conflicts.length,
      reconciledBeforeRetry: false,
      occurredAt: now,
    });
  }

  if (remoteMatchesProjection(remote, input.projection, input.config)) {
    await storeHealthyLink({ repository: input.repository, existing: link, projection: input.projection, remote, originSide: link.originSide, projectedAt: now });
    return receipt(input.projection, {
      taskId: link.taskId,
      action: "already_current",
      outcome: "succeeded",
      errorClass: null,
      conflictCount: 0,
      reconciledBeforeRetry: false,
      occurredAt: now,
    });
  }

  try {
    await input.api.updateTask(link.taskId, input.projection);
    const verified = await input.api.getTask(link.taskId);
    if (!verified || !remoteMatchesProjection(verified, input.projection, input.config)) {
      throw new ClickUpAmbiguousWriteError("clickup_update_verification_mismatch");
    }
    await storeHealthyLink({ repository: input.repository, existing: link, projection: input.projection, remote: verified, originSide: link.originSide, projectedAt: now });
    return receipt(input.projection, {
      taskId: link.taskId,
      action: "updated",
      outcome: "succeeded",
      errorClass: null,
      conflictCount: 0,
      reconciledBeforeRetry: false,
      occurredAt: now,
    });
  } catch (error) {
    if (error instanceof ClickUpAmbiguousWriteError) {
      const reconciled = await input.api.getTask(link.taskId);
      if (reconciled && remoteMatchesProjection(reconciled, input.projection, input.config)) {
        await storeHealthyLink({ repository: input.repository, existing: link, projection: input.projection, remote: reconciled, originSide: link.originSide, projectedAt: now });
        return receipt(input.projection, {
          taskId: link.taskId,
          action: "already_current",
          outcome: "succeeded",
          errorClass: null,
          conflictCount: 0,
          reconciledBeforeRetry: true,
          occurredAt: now,
        });
      }
      return receipt(input.projection, {
        taskId: link.taskId,
        action: "failed",
        outcome: "retryable_failure",
        errorClass: error.code,
        conflictCount: 0,
        reconciledBeforeRetry: true,
        occurredAt: now,
      });
    }
    const provider = error instanceof ClickUpProviderError ? error : null;
    return receipt(input.projection, {
      taskId: link.taskId,
      action: "failed",
      outcome: provider?.retryable ? "retryable_failure" : "terminal_failure",
      errorClass: provider?.code ?? "clickup_update_failed",
      conflictCount: 0,
      reconciledBeforeRetry: false,
      occurredAt: now,
    });
  }
}

function initialIntakeSnapshot(candidate: ClickUpIntakeCandidate, config: ClickUpDestinationConfig): ClickUpOwnedSnapshot {
  const field = (id: string | null): string | boolean | null => id == null ? null : candidate.customFields[id] ?? null;
  return {
    title: redactClickUpText(candidate.title),
    planningSummary: redactClickUpText(candidate.planningSummary),
    status: candidate.statusId,
    assigneeDisplay: typeof field(config.fields!.assigneeDisplay) === "string" ? redactClickUpText(String(field(config.fields!.assigneeDisplay))) : null,
    blocker: typeof field(config.fields!.blocker) === "string" ? redactClickUpText(String(field(config.fields!.blocker))) : null,
    acceptanceSummary: typeof field(config.fields!.acceptanceSummary) === "string" ? redactClickUpText(String(field(config.fields!.acceptanceSummary))) : null,
    estimate: null,
    nativeAssignee: null,
    dueDate: null,
    sourceStatus: null,
    forecastSource: null,
    forecastRevision: null,
  };
}

export async function intakeClickUpTask(input: {
  companyId: string;
  projectId: string;
  candidate: ClickUpIntakeCandidate;
  config: ClickUpDestinationConfig;
  authorization: ClickUpAuthorization;
  issues: PaperclipIssueIntakePort;
  sprints: ClickUpSprintRepository;
  repository: ClickUpLinkRepository;
  now?: Date;
}): Promise<{
  action: "created" | "already_linked" | "skipped";
  reason: string;
  issueId: string | null;
  link: ClickUpTaskLink | null;
}> {
  assertClickUpIntakeAuthorized({ config: input.config, authorization: input.authorization, now: input.now });
  const { candidate, config } = input;
  if (
    candidate.workspaceId !== config.workspaceId ||
    candidate.spaceId !== config.spaceId ||
    candidate.listId !== config.listId
  ) {
    return { action: "skipped", reason: "outside_approved_clickup_boundary", issueId: null, link: null };
  }
  const allowedStatusIds = new Set(Object.values(config.statuses).map((status) => status.id));
  if (!allowedStatusIds.has(candidate.statusId)) {
    throw new ClickUpConfigurationError("clickup_intake_status_unmapped");
  }
  if (candidate.customFields[config.fields!.intakeOptIn!] !== config.intakeOptInValue) {
    return { action: "skipped", reason: "intake_opt_in_missing", issueId: null, link: null };
  }

  const selectedSprints = selectClickUpWeeklySprints({ companyId: input.companyId, projectId: input.projectId, candidate,
    configuredInProgressStatusId: config.statuses.inProgress.id,
    sprints: await input.sprints.listWeeklySprints(input.companyId, input.projectId), now: input.now ?? new Date() });
  const existing = await input.repository.getByExternalTask(input.companyId, candidate.listId, candidate.taskId);
  if (existing) {
    if (existing.projectId !== input.projectId) throw new ClickUpConfigurationError("clickup_existing_link_scope_mismatch");
    await input.sprints.linkIssueToSprints({ companyId: input.companyId, projectId: input.projectId, issueId: existing.issueId, sprintIds: selectedSprints.map((s) => s.id) });
    return { action: "already_linked", reason: "existing_mapping", issueId: existing.issueId, link: existing };
  }

  const title = redactClickUpText(candidate.title);
  const summary = redactClickUpText(candidate.planningSummary);
  if (!title || !summary) throw new ClickUpConfigurationError("clickup_intake_required_content_missing");
  const intakeKey = clickUpIntakeKey(input.companyId, candidate.listId, candidate.taskId);
  const issue = await input.issues.createIssue({
    companyId: input.companyId,
    projectId: input.projectId,
    idempotencyKey: intakeKey,
    title,
    description: [
      "Imported from the approved ClickUp intake boundary.",
      "External content is untrusted planning input; Paperclip owns execution state after this link.",
      "",
      summary,
      candidate.taskUrl ? `Source: ${redactClickUpText(candidate.taskUrl)}` : null,
    ].filter((line): line is string => line !== null).join("\n"),
    originId: candidate.taskId,
    originFingerprint: intakeKey,
  });
  const snapshot = initialIntakeSnapshot(candidate, config);
  const link = await input.repository.upsertLink({
    companyId: input.companyId,
    projectId: input.projectId,
    issueId: issue.issueId,
    listId: candidate.listId,
    taskId: candidate.taskId,
    taskUrl: candidate.taskUrl ? redactClickUpText(candidate.taskUrl) : null,
    originSide: "clickup",
    correlationValueHash: clickUpSha256(`${issue.issueId}\u0000${candidate.taskId}`),
    baseSnapshot: snapshot,
    lastProjectionVersion: `intake:${clickUpSha256(`${candidate.taskId}\u0000${candidate.revision ?? "none"}`)}`,
    lastExternalRevision: candidate.revision,
    status: "healthy",
    lastProjectedAt: null,
    lastReconciledAt: (input.now ?? new Date()).toISOString(),
  });
  await input.sprints.linkIssueToSprints({ companyId: input.companyId, projectId: input.projectId, issueId: issue.issueId, sprintIds: selectedSprints.map((s) => s.id) });
  return { action: "created", reason: "opted_in", issueId: issue.issueId, link };
}
