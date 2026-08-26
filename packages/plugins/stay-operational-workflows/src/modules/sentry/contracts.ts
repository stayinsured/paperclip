import { createHash } from "node:crypto";
import type { EnvSecretRefBinding } from "@paperclipai/shared";

export const SENTRY_TRIAGE_AGENT_KEY = "sentry-triage";
export const SENTRY_TRIAGE_SKILL_KEY = "sentry-triage-proposal";
export const SENTRY_TRIAGE_ORIGIN_KIND = "plugin:staydigital.stay-operational-workflows:sentry-triage" as const;
export const SENTRY_REMEDIATION_ORIGIN_KIND = "plugin:staydigital.stay-operational-workflows:sentry-remediation" as const;
export const SENTRY_PROPOSAL_DOCUMENT_KEY = "remediation-proposal";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SAFE_CHANNEL = /^[CG][A-Z0-9]{8,20}$/;
const SAFE_VERSION = /^[A-Za-z0-9._:-]{1,160}$/;
const SLACK_ID_PLACEHOLDER = /^(?:T|C|G)(?:X{8,20}|0{8,20}|1{8,20}|12345678(?:90)?|EXAMPLE[A-Z0-9]*|PLACEHOLDER[A-Z0-9]*|TEST[A-Z0-9]*|YOUR[A-Z0-9]*)$/;
const REQUIRED_SENTRY_SCOPES = ["event:read", "org:read", "project:read"] as const;
const REQUIRED_SLACK_SCOPES = ["chat:write"] as const;
const PROHIBITED_TEXT = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*[^\s]*/i,
  /https?:\/\/[^\s]+\?[^\s]*/i,
];

export class SentryWorkflowConfigError extends Error {
  override readonly name = "SentryWorkflowConfigError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface ExactConfigurationApproval {
  issueId: string;
  documentKey: string;
  revisionId: string;
  revisionNumber: number;
  interactionId: string;
  configurationFingerprint: string;
  authorizedCapabilities: Array<"sentry.poll" | "slack.notify">;
}

export interface ProviderIdentityProof {
  principalId: string;
  scopes: string[];
  verifiedAt: string;
  expiresAt: string;
}

export interface SentryBroadScopeException {
  authorizationRevisionId: string;
  configurationFingerprint: string;
  principalId: string;
  secretBinding: EnvSecretRefBinding;
  secretBindingPath: "sentry.sentry.tokenRef";
  organizationId: string;
  organizationSlug: string;
  projectId: string;
  projectSlug: string;
  environment: "test";
  observedScopes: string[];
}

export interface LiveSentryAuthorization {
  principalId: string;
  scopes: string[];
  organizationId: string;
  organizationSlug: string;
  projectId: string;
  projectSlug: string;
  environment: string;
}

export interface SentryPilotConfig {
  companyId: string;
  projectId: string;
  pollingEnabled: boolean;
  slackEnabled: boolean;
  policyVersion: string;
  pollIntervalSeconds: 300;
  overlapSeconds: 600;
  dailyBackscanHours: 24;
  batchSize: number;
  maxPages: number;
  sentry: {
    apiBaseUrl: "https://sentry.io";
    organizationSlug: string;
    organizationId: string;
    projectSlug: string;
    projectId: string;
    environment: "test";
    tokenRef: EnvSecretRefBinding | null;
    identityProof: ProviderIdentityProof | null;
    broadScopeException: SentryBroadScopeException | null;
  };
  slack: {
    apiBaseUrl: "https://slack.com";
    teamId: string | null;
    channelId: string | null;
    appId: string | null;
    botUserId: string | null;
    botId: string | null;
    tokenRef: EnvSecretRefBinding | null;
    identityProof: ProviderIdentityProof | null;
  };
  remediationAssigneeAgentId: string | null;
  exactConfigurationApproval: ExactConfigurationApproval | null;
}

export interface FrozenSentrySnapshot {
  stableIssueId: string;
  organizationId: string;
  projectId: string;
  environment: "test";
  status: "unresolved" | "regressed" | "resolved" | "unknown";
  level: "fatal" | "error" | "warning" | "info" | "debug" | "unknown";
  firstSeen: string;
  lastSeen: string;
  aggregateEventCount: number;
  providerOccurrenceTimestamp: string;
  sanitizerVersion: "sentry-frozen-allowlist-v2";
  policyVersion: string;
  dedupeKey: string;
  correlationKey: string;
  processedAt: string;
}

export interface SentryIssuePage {
  issues: FrozenSentrySnapshot[];
  nextCursor: string | null;
}

export interface SentryPollWindow {
  start: string;
  end: string;
  mode: "incremental" | "daily_backscan" | "manual";
}

export interface RemediationProposal {
  proposal_revision: string;
  source: {
    stable_issue_id: string;
    project_id: string;
    environment: string;
  };
  data_handling: {
    allowlist_applied: true;
    excluded_sensitive_data: "present" | "not_observed" | "unknown";
    raw_detail_copied: false;
  };
  severity: {
    level: "critical" | "high" | "medium" | "low" | "unknown";
    confidence: "high" | "medium" | "low" | "unknown";
    rationale: string;
    urgency: string;
  };
  affected_component: Record<string, unknown>;
  evidence: unknown[];
  probable_root_cause: Record<string, unknown>;
  customer_impact: {
    confirmed: string[];
    unknown: string[];
    confidence: "high" | "medium" | "low" | "unknown";
  };
  diagnostic_next_step: Record<string, unknown>;
  fix_options: unknown[];
  no_fix_boundary: Record<string, unknown>;
  approval_gate: {
    required: true;
    target_revision: string;
    status: "not_requested" | "pending" | "approved" | "rejected" | "revision_required";
    execution_allowed: false;
    note: string;
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SentryWorkflowConfigError("invalid_schema", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, pattern = SAFE_ID): string {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new SentryWorkflowConfigError("invalid_schema", `${field} is invalid`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, pattern = SAFE_ID): string | null {
  if (value == null || value === "") return null;
  return requiredString(value, field, pattern);
}

function slackIdentity(value: unknown, field: string, pattern: RegExp, required: boolean): string | null {
  if (value == null) {
    if (!required) return null;
    throw new SentryWorkflowConfigError("invalid_schema", `${field} is invalid`);
  }
  const identity = requiredString(value, field, pattern);
  if (SLACK_ID_PLACEHOLDER.test(identity)) {
    throw new SentryWorkflowConfigError("invalid_schema", `${field} is invalid`);
  }
  return identity;
}

function positiveInteger(value: unknown, fallback: number, max: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || Number(normalized) < 1 || Number(normalized) > max) {
    throw new SentryWorkflowConfigError("invalid_schema", `${field} must be between 1 and ${max}`);
  }
  return Number(normalized);
}

function parseSecretRef(value: unknown, field: string): EnvSecretRefBinding | null {
  if (value == null) return null;
  const input = record(value, field);
  if (input.type !== "secret_ref") {
    throw new SentryWorkflowConfigError("secret_ref_required", `${field} must use a Paperclip secret reference`);
  }
  const secretId = requiredString(input.secretId, `${field}.secretId`, /^[0-9a-f-]{36}$/i);
  const version = input.version == null ? undefined : positiveInteger(input.version, 1, 2_147_483_647, `${field}.version`);
  return { type: "secret_ref", secretId, ...(version ? { version } : {}) };
}

function parseScopes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SentryWorkflowConfigError("invalid_schema", `${field} must be a string array`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].sort();
}

function parseIdentityProof(value: unknown, field: string): ProviderIdentityProof | null {
  if (value == null) return null;
  const input = record(value, field);
  const verifiedAt = new Date(requiredString(input.verifiedAt, `${field}.verifiedAt`, /^.+$/)).toISOString();
  const expiresAt = new Date(requiredString(input.expiresAt, `${field}.expiresAt`, /^.+$/)).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(verifiedAt)) {
    throw new SentryWorkflowConfigError("invalid_identity_proof", `${field} expires before it is valid`);
  }
  return {
    principalId: requiredString(input.principalId, `${field}.principalId`),
    scopes: parseScopes(input.scopes, `${field}.scopes`),
    verifiedAt,
    expiresAt,
  };
}

function parseApproval(value: unknown): ExactConfigurationApproval | null {
  if (value == null) return null;
  const input = record(value, "exactConfigurationApproval");
  if (!Array.isArray(input.authorizedCapabilities)) {
    throw new SentryWorkflowConfigError("invalid_schema", "authorizedCapabilities must be an array");
  }
  const capabilities = [...new Set(input.authorizedCapabilities)] as string[];
  if (capabilities.some((capability) => capability !== "sentry.poll" && capability !== "slack.notify")) {
    throw new SentryWorkflowConfigError("invalid_schema", "authorizedCapabilities contains an unsupported capability");
  }
  return {
    issueId: requiredString(input.issueId, "exactConfigurationApproval.issueId", /^[0-9a-f-]{36}$/i),
    documentKey: requiredString(input.documentKey, "exactConfigurationApproval.documentKey", /^[a-z0-9][a-z0-9-]{0,119}$/),
    revisionId: requiredString(input.revisionId, "exactConfigurationApproval.revisionId", /^[0-9a-f-]{36}$/i),
    revisionNumber: positiveInteger(input.revisionNumber, 1, 1_000_000, "exactConfigurationApproval.revisionNumber"),
    interactionId: requiredString(input.interactionId, "exactConfigurationApproval.interactionId", /^[0-9a-f-]{36}$/i),
    configurationFingerprint: requiredString(input.configurationFingerprint, "exactConfigurationApproval.configurationFingerprint", /^sha256:[0-9a-f]{64}$/),
    authorizedCapabilities: capabilities as ExactConfigurationApproval["authorizedCapabilities"],
  };
}

function parseSentryBroadScopeException(value: unknown): SentryBroadScopeException | null {
  if (value == null) return null;
  const input = record(value, "sentry.broadScopeException");
  const secretBinding = parseSecretRef(input.secretBinding, "sentry.broadScopeException.secretBinding");
  if (!secretBinding) throw new SentryWorkflowConfigError("broad_scope_exception_required", "Sentry broad-scope exception secret binding is required");
  return {
    authorizationRevisionId: requiredString(input.authorizationRevisionId, "sentry.broadScopeException.authorizationRevisionId", /^[0-9a-f-]{36}$/i),
    configurationFingerprint: requiredString(input.configurationFingerprint, "sentry.broadScopeException.configurationFingerprint", /^sha256:[0-9a-f]{64}$/),
    principalId: requiredString(input.principalId, "sentry.broadScopeException.principalId"),
    secretBinding,
    secretBindingPath: requiredString(input.secretBindingPath, "sentry.broadScopeException.secretBindingPath", /^sentry\.sentry\.tokenRef$/) as "sentry.sentry.tokenRef",
    organizationId: requiredString(input.organizationId, "sentry.broadScopeException.organizationId", /^\d{1,30}$/),
    organizationSlug: requiredString(input.organizationSlug, "sentry.broadScopeException.organizationSlug", SAFE_SLUG),
    projectId: requiredString(input.projectId, "sentry.broadScopeException.projectId", /^\d{1,30}$/),
    projectSlug: requiredString(input.projectSlug, "sentry.broadScopeException.projectSlug", SAFE_SLUG),
    environment: requiredString(input.environment, "sentry.broadScopeException.environment") as "test",
    observedScopes: parseScopes(input.observedScopes, "sentry.broadScopeException.observedScopes"),
  };
}

function assertExactScopes(actual: string[], required: readonly string[], provider: string): void {
  if (actual.length !== required.length || required.some((scope) => !actual.includes(scope))) {
    throw new SentryWorkflowConfigError(
      "least_privilege_scope_required",
      `${provider} scopes must be exactly ${required.join(", ")}`,
    );
  }
}

function assertRequiredScopes(actual: string[], required: readonly string[], provider: string): void {
  if (required.some((scope) => !actual.includes(scope))) {
    throw new SentryWorkflowConfigError(
      "required_read_scope_missing",
      `${provider} scopes must include ${required.join(", ")}`,
    );
  }
}

export function parseSentryPilotConfig(input: Record<string, unknown>): SentryPilotConfig {
  const sentryInput = record(input.sentry, "sentry");
  const slackInput = record(input.slack, "slack");
  const pollingEnabled = input.pollingEnabled === true;
  const slackEnabled = input.slackEnabled === true;
  if (slackEnabled && !pollingEnabled) {
    throw new SentryWorkflowConfigError("polling_required", "Slack notification requires Sentry polling");
  }
  const sentryProof = parseIdentityProof(sentryInput.identityProof, "sentry.identityProof");
  const slackProof = parseIdentityProof(slackInput.identityProof, "slack.identityProof");
  const approval = parseApproval(input.exactConfigurationApproval);
  const broadScopeException = parseSentryBroadScopeException(sentryInput.broadScopeException);
  const config: SentryPilotConfig = {
    companyId: requiredString(input.companyId, "companyId", /^[0-9a-f-]{36}$/i),
    projectId: requiredString(input.projectId, "projectId", /^[0-9a-f-]{36}$/i),
    pollingEnabled,
    slackEnabled,
    policyVersion: requiredString(input.policyVersion, "policyVersion", SAFE_VERSION),
    pollIntervalSeconds: 300,
    overlapSeconds: 600,
    dailyBackscanHours: 24,
    batchSize: positiveInteger(input.batchSize, 100, 100, "batchSize"),
    maxPages: positiveInteger(input.maxPages, 100, 1_000, "maxPages"),
    sentry: {
      apiBaseUrl: "https://sentry.io",
      organizationSlug: requiredString(sentryInput.organizationSlug, "sentry.organizationSlug", SAFE_SLUG),
      organizationId: requiredString(sentryInput.organizationId, "sentry.organizationId", /^\d{1,30}$/),
      projectSlug: requiredString(sentryInput.projectSlug, "sentry.projectSlug", SAFE_SLUG),
      projectId: requiredString(sentryInput.projectId, "sentry.projectId", /^\d{1,30}$/),
      environment: requiredString(sentryInput.environment, "sentry.environment") as "test",
      tokenRef: parseSecretRef(sentryInput.tokenRef, "sentry.tokenRef"),
      identityProof: sentryProof,
      broadScopeException,
    },
    slack: {
      apiBaseUrl: "https://slack.com",
      teamId: slackIdentity(slackInput.teamId, "slack.teamId", /^T[A-Z0-9]{8,20}$/, slackEnabled),
      channelId: slackIdentity(slackInput.channelId, "slack.channelId", SAFE_CHANNEL, slackEnabled),
      appId: optionalString(slackInput.appId, "slack.appId", /^A[A-Z0-9]{8,20}$/),
      botUserId: optionalString(slackInput.botUserId, "slack.botUserId", /^[UW][A-Z0-9]{8,20}$/),
      botId: optionalString(slackInput.botId, "slack.botId", /^B[A-Z0-9]{8,20}$/),
      tokenRef: parseSecretRef(slackInput.tokenRef, "slack.tokenRef"),
      identityProof: slackProof,
    },
    remediationAssigneeAgentId: optionalString(input.remediationAssigneeAgentId, "remediationAssigneeAgentId", /^[0-9a-f-]{36}$/i),
    exactConfigurationApproval: approval,
  };
  if (config.sentry.environment !== "test") {
    throw new SentryWorkflowConfigError("wrong_environment", "Only the approved Sentry test environment is allowed");
  }
  if (pollingEnabled) {
    if (!config.sentry.tokenRef || !sentryProof || !approval?.authorizedCapabilities.includes("sentry.poll")) {
      throw new SentryWorkflowConfigError("sentry_activation_unproven", "Sentry polling requires a token ref, identity proof, and exact approval");
    }
    assertRequiredScopes(sentryProof.scopes, REQUIRED_SENTRY_SCOPES, "Sentry");
    if (sentryProof.scopes.length > REQUIRED_SENTRY_SCOPES.length && !broadScopeException) {
      throw new SentryWorkflowConfigError("broad_scope_exception_required", "Sentry credentials with additional scopes require an exact revision-bound exception");
    }
    if (broadScopeException) assertRequiredScopes(broadScopeException.observedScopes, REQUIRED_SENTRY_SCOPES, "Sentry broad-scope exception");
  }
  if (slackEnabled) {
    if (
      !config.slack.tokenRef
      || !slackProof
      || !config.slack.appId
      || !config.slack.botUserId
      || !config.slack.botId
      || !approval?.authorizedCapabilities.includes("slack.notify")
    ) {
      throw new SentryWorkflowConfigError("slack_activation_unproven", "Slack notification requires exact bot identity, token ref, scope proof, and approval");
    }
    assertExactScopes(slackProof.scopes, REQUIRED_SLACK_SCOPES, "Slack");
  }
  return config;
}

export function configurationFingerprint(config: SentryPilotConfig): string {
  const canonical = {
    companyId: config.companyId,
    projectId: config.projectId,
    policyVersion: config.policyVersion,
    pollingEnabled: config.pollingEnabled,
    slackEnabled: config.slackEnabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    overlapSeconds: config.overlapSeconds,
    dailyBackscanHours: config.dailyBackscanHours,
    sentry: {
      organizationSlug: config.sentry.organizationSlug,
      organizationId: config.sentry.organizationId,
      projectSlug: config.sentry.projectSlug,
      projectId: config.sentry.projectId,
      environment: config.sentry.environment,
      principalId: config.sentry.identityProof?.principalId ?? null,
      scopes: config.sentry.identityProof?.scopes ?? [],
      tokenRef: config.sentry.tokenRef,
      broadScopeException: config.sentry.broadScopeException ? {
        authorizationRevisionId: config.sentry.broadScopeException.authorizationRevisionId,
        principalId: config.sentry.broadScopeException.principalId,
        secretBinding: config.sentry.broadScopeException.secretBinding,
        secretBindingPath: config.sentry.broadScopeException.secretBindingPath,
        organizationId: config.sentry.broadScopeException.organizationId,
        organizationSlug: config.sentry.broadScopeException.organizationSlug,
        projectId: config.sentry.broadScopeException.projectId,
        projectSlug: config.sentry.broadScopeException.projectSlug,
        environment: config.sentry.broadScopeException.environment,
        observedScopes: config.sentry.broadScopeException.observedScopes,
      } : null,
    },
    slack: {
      teamId: config.slack.teamId,
      channelId: config.slack.channelId,
      appId: config.slack.appId,
      botUserId: config.slack.botUserId,
      botId: config.slack.botId,
      principalId: config.slack.identityProof?.principalId ?? null,
      scopes: config.slack.identityProof?.scopes ?? [],
    },
    remediationAssigneeAgentId: config.remediationAssigneeAgentId,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function assertRuntimeAuthorization(config: SentryPilotConfig, now: Date): void {
  const approval = config.exactConfigurationApproval;
  const fingerprint = configurationFingerprint(config);
  if (!approval || approval.configurationFingerprint !== fingerprint) {
    throw new SentryWorkflowConfigError("stale_configuration_approval", "The accepted configuration fingerprint is missing or stale");
  }
  if (config.pollingEnabled && (!config.sentry.identityProof || Date.parse(config.sentry.identityProof.expiresAt) <= now.getTime())) {
    throw new SentryWorkflowConfigError("sentry_identity_expired", "The Sentry identity proof is missing or expired");
  }
  if (config.pollingEnabled) {
    const exception = config.sentry.broadScopeException;
    const proof = config.sentry.identityProof;
    if (!proof) {
      throw new SentryWorkflowConfigError("sentry_identity_expired", "The Sentry identity proof is missing or expired");
    }
    assertRequiredScopes(proof.scopes, REQUIRED_SENTRY_SCOPES, "Sentry");
    if (proof.scopes.length > REQUIRED_SENTRY_SCOPES.length && !exception) {
      throw new SentryWorkflowConfigError("broad_scope_exception_required", "The current broad Sentry credential lacks an exact exception");
    }
    if (exception && (
      exception.authorizationRevisionId !== approval.revisionId
      || exception.configurationFingerprint !== fingerprint
      || exception.configurationFingerprint !== approval.configurationFingerprint
      || exception.principalId !== proof.principalId
      || JSON.stringify(exception.secretBinding) !== JSON.stringify(config.sentry.tokenRef)
      || exception.secretBindingPath !== "sentry.sentry.tokenRef"
      || exception.organizationId !== config.sentry.organizationId
      || exception.organizationSlug !== config.sentry.organizationSlug
      || exception.projectId !== config.sentry.projectId
      || exception.projectSlug !== config.sentry.projectSlug
      || exception.environment !== config.sentry.environment
      || exception.observedScopes.join("\u001f") !== proof.scopes.join("\u001f")
    )) {
      throw new SentryWorkflowConfigError("broad_scope_exception_mismatch", "The Sentry broad-scope exception does not exactly match the current authorization");
    }
  }
  if (config.slackEnabled && (!config.slack.identityProof || Date.parse(config.slack.identityProof.expiresAt) <= now.getTime())) {
    throw new SentryWorkflowConfigError("slack_identity_expired", "The Slack identity proof is missing or expired");
  }
}

export function assertLiveSentryAuthorization(config: SentryPilotConfig, live: LiveSentryAuthorization): void {
  const proof = config.sentry.identityProof;
  const scopes = [...new Set(live.scopes)].sort();
  if (!proof
    || live.principalId !== proof.principalId
    || scopes.join("\u001f") !== proof.scopes.join("\u001f")
    || live.organizationId !== config.sentry.organizationId
    || live.organizationSlug !== config.sentry.organizationSlug
    || live.projectId !== config.sentry.projectId
    || live.projectSlug !== config.sentry.projectSlug
    || live.environment !== config.sentry.environment) {

    throw new SentryWorkflowConfigError("live_sentry_authorization_mismatch", "Live Sentry identity, complete scopes, or exact target drifted from the authorized configuration");
  }
}
export interface SentryAllowlistedObservation {
  stableIssueId: string;
  status: FrozenSentrySnapshot["status"];
  level: FrozenSentrySnapshot["level"];
  firstSeen: string;
  lastSeen: string;
  aggregateEventCount: number;
  providerOccurrenceTimestamp: string;
}

export function freezeSentrySnapshot(config: SentryPilotConfig, issue: SentryAllowlistedObservation, processedAt: Date): FrozenSentrySnapshot {
  const stableIdentity = [config.companyId, config.sentry.organizationId, config.sentry.projectId, issue.stableIssueId].join(":");
  const correlationKey = createHash("sha256").update(stableIdentity).digest("hex");
  return Object.freeze({
    stableIssueId: issue.stableIssueId,
    organizationId: config.sentry.organizationId,
    projectId: config.sentry.projectId,
    environment: config.sentry.environment,
    status: issue.status,
    level: issue.level,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    aggregateEventCount: issue.aggregateEventCount,
    providerOccurrenceTimestamp: issue.providerOccurrenceTimestamp,
    sanitizerVersion: "sentry-frozen-allowlist-v2",
    policyVersion: config.policyVersion,
    dedupeKey: createHash("sha256").update([stableIdentity, issue.lastSeen, issue.aggregateEventCount].join("\u001f")).digest("hex"),
    correlationKey,
    processedAt: processedAt.toISOString(),
  });
}
export function stableSentryIdentity(config: SentryPilotConfig, stableIssueId: string): string {
  return [config.companyId, config.sentry.organizationId, config.sentry.projectId, stableIssueId].join(":");
}

export function notificationIdentity(config: SentryPilotConfig, stableIssueId: string, proposalRevisionId: string): string {
  return createHash("sha256")
    .update([stableSentryIdentity(config, stableIssueId), proposalRevisionId, config.slack.teamId, config.slack.channelId].join("\u001f"))
    .digest("hex");
}


function safeDate(value: unknown, field: string): string {
  if (typeof value !== "string") throw new SentryWorkflowConfigError("invalid_source_schema", `${field} is missing`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new SentryWorkflowConfigError("invalid_source_schema", `${field} is invalid`);
  return date.toISOString();
}

function safeAggregateCount(value: unknown): number {
  const count = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new SentryWorkflowConfigError("invalid_source_schema", "Sentry issue count is invalid");
  }
  return count;
}


export function sanitizeSentryIssue(raw: unknown, config: SentryPilotConfig, processedAt: Date = new Date()): FrozenSentrySnapshot {
  const input = record(raw, "Sentry issue");
  const project = record(input.project, "Sentry issue project");
  if (String(project.id) !== config.sentry.projectId || project.slug !== config.sentry.projectSlug) {
    throw new SentryWorkflowConfigError("wrong_sentry_scope", "Sentry returned an issue outside the approved project");
  }
  const observedEnvironment = input.matchingEventEnvironment;
  if (observedEnvironment !== config.sentry.environment) {
    throw new SentryWorkflowConfigError("wrong_environment", "Sentry returned an issue from a prohibited environment");
  }
  const statusDetails = input.statusDetails && typeof input.statusDetails === "object"
    ? input.statusDetails as Record<string, unknown>
    : {};
  const substatus = typeof input.substatus === "string" ? input.substatus : "unknown";
  const rawStatus = typeof input.status === "string" ? input.status : "unknown";
  const status: FrozenSentrySnapshot["status"] = rawStatus === "regressed" || substatus === "regressed" || statusDetails.regressed === true
    ? "regressed"
    : rawStatus === "unresolved" || rawStatus === "resolved" ? rawStatus : "unknown";
  const allowedLevels = ["fatal", "error", "warning", "info", "debug"] as const;
  const level: FrozenSentrySnapshot["level"] = typeof input.level === "string" && (allowedLevels as readonly string[]).includes(input.level)
    ? input.level as FrozenSentrySnapshot["level"]
    : "unknown";
  const firstSeen = safeDate(input.firstSeen, "firstSeen");
  const lastSeen = safeDate(input.lastSeen, "lastSeen");
  const aggregateEventCount = safeAggregateCount(input.count);
  return freezeSentrySnapshot(config, {
    stableIssueId: requiredString(input.id, "Sentry issue id", /^\d{1,30}$/),
    status,
    level,
    firstSeen,
    lastSeen,
    aggregateEventCount,
    providerOccurrenceTimestamp: lastSeen,
  }, processedAt);
}

const PROPOSAL_KEYS = [
  "proposal_revision",
  "source",
  "data_handling",
  "severity",
  "affected_component",
  "evidence",
  "probable_root_cause",
  "customer_impact",
  "diagnostic_next_step",
  "fix_options",
  "no_fix_boundary",
  "approval_gate",
] as const;

function assertSafeTextTree(value: unknown, path = "proposal"): void {
  if (typeof value === "string") {
    if (value.length > 4_000 || PROHIBITED_TEXT.some((pattern) => pattern.test(value))) {
      throw new SentryWorkflowConfigError("proposal_contains_prohibited_data", `${path} contains prohibited or oversized text`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new SentryWorkflowConfigError("invalid_proposal", `${path} is too large`);
    value.forEach((entry, index) => assertSafeTextTree(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertSafeTextTree(entry, `${path}.${key}`);
    }
  }
}

export function parseRemediationProposal(body: string, source: FrozenSentrySnapshot): RemediationProposal {
  if (body.length > 60_000) throw new SentryWorkflowConfigError("invalid_proposal", "Proposal document is too large");
  let parsed: unknown;
  try {
    const trimmed = body.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SentryWorkflowConfigError("invalid_proposal", "Proposal must be JSON using the skill's exact output contract");
  }
  const proposal = record(parsed, "proposal");
  const keys = Object.keys(proposal).sort();
  if (keys.join("\u001f") !== [...PROPOSAL_KEYS].sort().join("\u001f")) {
    throw new SentryWorkflowConfigError("invalid_proposal", "Proposal top-level fields do not match the triage skill contract");
  }
  const sourceBlock = record(proposal.source, "proposal.source");
  const handling = record(proposal.data_handling, "proposal.data_handling");
  const severity = record(proposal.severity, "proposal.severity");
  const impact = record(proposal.customer_impact, "proposal.customer_impact");
  const gate = record(proposal.approval_gate, "proposal.approval_gate");
  const revision = requiredString(proposal.proposal_revision, "proposal_revision", /^[A-Za-z0-9._:-]{1,160}$/);
  if (
    sourceBlock.stable_issue_id !== source.stableIssueId
    || sourceBlock.project_id !== source.projectId
    || sourceBlock.environment !== source.environment
  ) {
    throw new SentryWorkflowConfigError("proposal_source_mismatch", "Proposal source does not match the configured Sentry issue");
  }
  if (handling.allowlist_applied !== true || handling.raw_detail_copied !== false) {
    throw new SentryWorkflowConfigError("proposal_data_boundary_failed", "Proposal did not attest the required data boundary");
  }
  if (gate.required !== true || gate.execution_allowed !== false || gate.target_revision !== revision) {
    throw new SentryWorkflowConfigError("proposal_gate_failed", "Proposal approval gate is missing or inconsistent");
  }
  const levels = ["critical", "high", "medium", "low", "unknown"];
  const confidence = ["high", "medium", "low", "unknown"];
  if (!levels.includes(String(severity.level)) || !confidence.includes(String(severity.confidence))) {
    throw new SentryWorkflowConfigError("invalid_proposal", "Proposal severity is invalid");
  }
  if (!Array.isArray(impact.confirmed) || !Array.isArray(impact.unknown)) {
    throw new SentryWorkflowConfigError("invalid_proposal", "Proposal impact fields are invalid");
  }
  assertSafeTextTree(proposal);
  return proposal as unknown as RemediationProposal;
}

export function buildSlackSummary(input: {
  source: FrozenSentrySnapshot;
  proposal: RemediationProposal;
  paperclipIssueUrl: string;
}): string {
  const impact = input.proposal.customer_impact.confirmed.length > 0
    ? input.proposal.customer_impact.confirmed.join("; ").slice(0, 500)
    : "Impact is not confirmed.";
  const text = [
    "Sentry issue: " + input.source.stableIssueId,
    `Severity: ${input.proposal.severity.level} (${input.proposal.severity.confidence} confidence)`,
    "Project ID: " + input.source.projectId,
    "First seen: " + input.source.firstSeen,
    "Last seen: " + input.source.lastSeen,
    "Count: " + input.source.aggregateEventCount,
    "Impact: " + impact,
    "Paperclip triage: " + input.paperclipIssueUrl,
    "Approval is in Paperclip.",
  ].join("\n");
  assertSafeTextTree(text, "Slack summary");
  return text;
}
