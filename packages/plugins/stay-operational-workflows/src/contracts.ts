import { createHash } from "node:crypto";
import type { OutlineModuleActivation } from "./modules/outline/types.js";

export const WORKFLOW_MODULES = ["outline", "clickup", "sentry_slack"] as const;
export type WorkflowModule = (typeof WORKFLOW_MODULES)[number];

export type OperationStatus =
  | "pending"
  | "retry_wait"
  | "reconciling"
  | "shadowed"
  | "published"
  | "skipped"
  | "failed"
  | "conflict";

export interface AuditIdentity {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string | null;
  runId: string | null;
}

export interface ModuleConfig {
  companyId: string;
  projectId: string;
  module: WorkflowModule;
  enabled: boolean;
  readOnly: boolean;
  destinationEnabled: boolean;
  destinationKey: string | null;
  /**
   * Approved Outline activation payload (exact destination configuration plus
   * its board-accepted authorization). Null for every shadow configuration.
   * Only the outline module may carry one; deep validation happens at the
   * configuration boundary and again on every reconciliation.
   */
  outlineActivation: OutlineModuleActivation | null;
  sourceVersion: string;
  policyVersion: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  overlapSeconds: number;
  batchSize: number;
}

export interface SourceCandidate {
  companyId: string;
  projectId: string;
  module: WorkflowModule;
  sourceKind: "paperclip_issue" | "manual_replay";
  sourceId: string;
  sourceVersion: string;
  policyVersion: string;
  cursorValue: string;
  sourceStatus: string;
}

export interface RedactedReceipt {
  schemaVersion: 1;
  category: "shadow" | "retry" | "exception" | "conflict" | "reconciled" | "publish";
  code: string;
  status: string;
  occurredAt: string;
  outcomeIdentity: string;
  externalWriteAttempted: boolean;
}

export interface RetryDecision {
  status: "retry_wait" | "reconciling" | "failed";
  exceptionKind:
    | "rate_limited"
    | "provider_unavailable"
    | "ambiguous_timeout"
    | "revoked_credential"
    | "invalid_schema"
    | "permanent_failure";
  retryAt: string | null;
}

export interface AttemptFailure {
  kind?: "ambiguous_timeout" | "invalid_schema";
  httpStatus?: number;
}

export type WorkflowRequestErrorCode =
  | "invalid_workflow_config"
  | "project_not_found"
  | "operation_not_found";

export class WorkflowRequestError extends Error {
  override readonly name = "WorkflowRequestError";

  constructor(
    readonly status: 404 | 422,
    readonly code: WorkflowRequestErrorCode,
    message: string,
    readonly publicMessage: string,
  ) {
    super(message);
  }
}

function invalidWorkflowConfig(message: string): WorkflowRequestError {
  return new WorkflowRequestError(
    422,
    "invalid_workflow_config",
    message,
    "Workflow configuration validation failed",
  );
}

// Underscores are allowed because issue statuses ("in_progress") and Outline
// publisher error classes ("outline_mcp_rate_limited") are snake_case.
const SAFE_VERSION = /^[a-zA-Z0-9._:-]{1,120}$/;
const SAFE_DESTINATION = /^[a-zA-Z0-9._:/-]{1,200}$/;

function requiredString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidWorkflowConfig(`${field} is required`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw invalidWorkflowConfig(`${field} contains unsupported characters`);
  }
  return normalized;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const parsed = value === undefined ? fallback : value;
  if (!Number.isInteger(parsed) || Number(parsed) < min || Number(parsed) > max) {
    throw invalidWorkflowConfig(`${field} must be an integer between ${min} and ${max}`);
  }
  return Number(parsed);
}

export function parseModuleConfig(input: Record<string, unknown>): ModuleConfig {
  const module = requiredString(input.module, "module") as WorkflowModule;
  if (!WORKFLOW_MODULES.includes(module)) {
    throw invalidWorkflowConfig(`Unsupported module: ${module}`);
  }

  const outlineActivation = parseOutlineActivationField(input.outlineActivation, module);
  const config: ModuleConfig = {
    companyId: requiredString(input.companyId, "companyId"),
    projectId: requiredString(input.projectId, "projectId"),
    module,
    enabled: input.enabled === true,
    readOnly: input.readOnly !== false,
    destinationEnabled: input.destinationEnabled === true,
    destinationKey: input.destinationKey == null || input.destinationKey === ""
      ? null
      : requiredString(input.destinationKey, "destinationKey", SAFE_DESTINATION),
    outlineActivation,
    sourceVersion: requiredString(input.sourceVersion ?? "paperclip-v1", "sourceVersion", SAFE_VERSION),
    policyVersion: requiredString(input.policyVersion ?? "shadow-v1", "policyVersion", SAFE_VERSION),
    maxAttempts: boundedInteger(input.maxAttempts, 5, 1, 10, "maxAttempts"),
    baseDelayMs: boundedInteger(input.baseDelayMs, 1_000, 100, 60_000, "baseDelayMs"),
    maxDelayMs: boundedInteger(input.maxDelayMs, 300_000, 1_000, 3_600_000, "maxDelayMs"),
    overlapSeconds: boundedInteger(input.overlapSeconds, 300, 0, 3_600, "overlapSeconds"),
    batchSize: boundedInteger(input.batchSize, 200, 1, 1_000, "batchSize"),
  };
  if (config.module !== "outline") {
    assertShadowOnly(config);
  } else if (config.outlineActivation == null) {
    // No approved activation payload: the structural shadow-only limit stands.
    assertShadowOnly(config);
  } else if (config.destinationKey !== config.outlineActivation.destination.connectionId) {
    throw invalidWorkflowConfig(
      "destinationKey must equal the approved Outline activation connectionId",
    );
  }
  if (config.maxDelayMs < config.baseDelayMs) {
    throw invalidWorkflowConfig("maxDelayMs must be at least baseDelayMs");
  }
  return config;
}

function parseOutlineActivationField(
  input: unknown,
  module: WorkflowModule,
): ModuleConfig["outlineActivation"] {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw invalidWorkflowConfig("outlineActivation must be an object");
  }
  const payload = input as Record<string, unknown>;
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.destination !== "object" || payload.destination == null
    || typeof payload.authorization !== "object" || payload.authorization == null
  ) {
    throw invalidWorkflowConfig("outlineActivation must carry schemaVersion 1, destination, and authorization");
  }
  if (module !== "outline") {
    throw invalidWorkflowConfig("Only the outline module accepts an activation payload");
  }
  // Deep gate validation (fingerprint, writer proofs, expiry) runs at the
  // configuration boundary and again on every reconciliation.
  return payload as unknown as ModuleConfig["outlineActivation"];
}

export function assertShadowOnly(config: Pick<ModuleConfig, "readOnly" | "destinationEnabled">): void {
  if (!config.readOnly || config.destinationEnabled) {
    throw invalidWorkflowConfig(
      "This plugin release is shadow-only without an approved outline activation: readOnly must be true and destinationEnabled must be false",
    );
  }
}

/**
 * True only when the outline module carries an activation payload AND every
 * external-write switch is on. Dormant forms (payload retained with the module
 * disabled or read-only) are the kill-switch positions and never publish.
 */
export function isOutlineActiveConfig(config: Pick<
  ModuleConfig,
  "module" | "enabled" | "readOnly" | "destinationEnabled" | "outlineActivation"
>): boolean {
  return config.module === "outline"
    && config.enabled
    && !config.readOnly
    && config.destinationEnabled
    && config.outlineActivation != null;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deterministicOperationKey(candidate: SourceCandidate): string {
  return sha256([
    candidate.companyId,
    candidate.module,
    candidate.sourceKind,
    candidate.sourceId,
    candidate.sourceVersion,
    candidate.policyVersion,
  ].join("\u001f"));
}

export function outcomeIdentity(operationKey: string): string {
  return `sha256:${sha256(`outcome\u001f${operationKey}`)}`;
}

export function createRedactedReceipt(input: {
  operationKey: string;
  category: RedactedReceipt["category"];
  code: string;
  status: string;
  occurredAt: string;
  externalWriteAttempted?: boolean;
}): RedactedReceipt {
  return {
    schemaVersion: 1,
    category: input.category,
    code: requiredString(input.code, "code", SAFE_VERSION),
    status: requiredString(input.status, "status", SAFE_VERSION),
    occurredAt: new Date(input.occurredAt).toISOString(),
    outcomeIdentity: outcomeIdentity(input.operationKey),
    externalWriteAttempted: input.externalWriteAttempted ?? false,
  };
}

export function classifyFailure(
  failure: AttemptFailure,
  attempt: number,
  config: Pick<ModuleConfig, "maxAttempts" | "baseDelayMs" | "maxDelayMs">,
  now: Date,
): RetryDecision {
  if (failure.kind === "ambiguous_timeout") {
    return { status: "reconciling", exceptionKind: "ambiguous_timeout", retryAt: null };
  }
  if (failure.kind === "invalid_schema") {
    return { status: "failed", exceptionKind: "invalid_schema", retryAt: null };
  }
  if (failure.httpStatus === 401 || failure.httpStatus === 403) {
    return { status: "failed", exceptionKind: "revoked_credential", retryAt: null };
  }
  const retryable = failure.httpStatus === 429
    || (failure.httpStatus != null && failure.httpStatus >= 500 && failure.httpStatus <= 599);
  if (!retryable || attempt >= config.maxAttempts) {
    return {
      status: "failed",
      exceptionKind: retryable
        ? failure.httpStatus === 429 ? "rate_limited" : "provider_unavailable"
        : "permanent_failure",
      retryAt: null,
    };
  }
  const delayMs = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  return {
    status: "retry_wait",
    exceptionKind: failure.httpStatus === 429 ? "rate_limited" : "provider_unavailable",
    retryAt: new Date(now.getTime() + delayMs).toISOString(),
  };
}

export function candidateFromIssueRow(
  row: Record<string, unknown>,
  config: ModuleConfig,
): SourceCandidate {
  const companyId = requiredString(row.company_id, "issue.company_id");
  const projectId = requiredString(row.project_id, "issue.project_id");
  if (companyId !== config.companyId || projectId !== config.projectId) {
    throw new Error("Issue row is outside the configured company/project boundary");
  }
  const sourceId = requiredString(row.id, "issue.id");
  const updatedAt = new Date(requiredString(row.updated_at, "issue.updated_at")).toISOString();
  const status = requiredString(row.status, "issue.status", SAFE_VERSION);
  return {
    companyId,
    projectId,
    module: config.module,
    sourceKind: "paperclip_issue",
    sourceId,
    sourceVersion: `${config.sourceVersion}:${sha256(`${status}\u001f${updatedAt}`).slice(0, 24)}`,
    policyVersion: config.policyVersion,
    cursorValue: `${updatedAt}|${sourceId}`,
    sourceStatus: status,
  };
}
