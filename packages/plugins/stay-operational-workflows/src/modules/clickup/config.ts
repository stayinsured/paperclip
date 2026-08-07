import { clickUpConfigurationFingerprint } from "./identity.js";
import type {
  ClickUpAuthorization,
  ClickUpDestinationConfig,
  ClickUpShadowProjection,
} from "./types.js";

const REQUIRED_STATUS_NAMES = {
  toDo: "to do",
  inProgress: "in progress",
  readyForQa: "ready for qa",
  complete: "complete",
} as const;

export class ClickUpConfigurationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ClickUpConfigurationError";
  }
}

function requiredExactId(value: string | null | undefined, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ClickUpConfigurationError(code);
  const normalized = value.trim();
  if (/^(null|unselected|unprovisioned|unproven)$/i.test(normalized)) {
    throw new ClickUpConfigurationError(code);
  }
  return normalized;
}

export function assertClickUpDestinationConfigured(config: ClickUpDestinationConfig): void {
  let url: URL;
  try {
    url = new URL(config.apiBaseUrl);
  } catch {
    throw new ClickUpConfigurationError("clickup_api_url_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ClickUpConfigurationError("clickup_api_url_not_https");
  }
  requiredExactId(config.tokenSecretId, "clickup_principal_unprovisioned");
  requiredExactId(config.workspaceId, "clickup_workspace_id_missing");
  requiredExactId(config.spaceId, "clickup_space_id_missing");
  requiredExactId(config.listId, "clickup_list_id_missing");

  const seenStatusIds = new Set<string>();
  for (const [key, requiredName] of Object.entries(REQUIRED_STATUS_NAMES)) {
    const configured = config.statuses[key as keyof typeof config.statuses];
    const id = requiredExactId(configured?.id, `clickup_${key}_status_id_missing`);
    if (configured.name.trim().toLowerCase() !== requiredName) {
      throw new ClickUpConfigurationError(`clickup_${key}_status_name_mismatch`);
    }
    if (seenStatusIds.has(id)) throw new ClickUpConfigurationError("clickup_status_ids_not_unique");
    seenStatusIds.add(id);
  }

  const requiredFields = [
    "paperclipIssueId",
    "planningSummary",
    "assigneeDisplay",
    "blocker",
    "acceptanceSummary",
    "estimateNeeded",
    "projectionVersion",
  ] as const;
  const seenFieldIds = new Set<string>();
  for (const key of requiredFields) {
    const id = requiredExactId(config.fields[key], `clickup_${key}_field_id_missing`);
    if (seenFieldIds.has(id)) throw new ClickUpConfigurationError("clickup_field_ids_not_unique");
    seenFieldIds.add(id);
  }
  if (config.fields.intakeOptIn != null) {
    const id = requiredExactId(config.fields.intakeOptIn, "clickup_intake_field_id_missing");
    if (seenFieldIds.has(id)) throw new ClickUpConfigurationError("clickup_field_ids_not_unique");
  }
}

function assertApprovalAndProof(input: {
  config: ClickUpDestinationConfig;
  authorization: ClickUpAuthorization;
  now?: Date;
}): void {
  assertClickUpDestinationConfigured(input.config);
  const { authorization, config } = input;
  if (!authorization.enabled) throw new ClickUpConfigurationError("clickup_module_disabled");
  const fingerprint = clickUpConfigurationFingerprint(config);
  const approval = authorization.exactConfigurationApproval;
  if (!approval || approval.status !== "accepted") {
    throw new ClickUpConfigurationError("clickup_exact_configuration_not_approved");
  }
  if (approval.configurationFingerprint !== fingerprint) {
    throw new ClickUpConfigurationError("clickup_configuration_changed_after_approval");
  }
  const proof = authorization.listAccessProof;
  if (!proof) throw new ClickUpConfigurationError("clickup_list_access_proof_missing");
  if (proof.configurationFingerprint !== fingerprint) {
    throw new ClickUpConfigurationError("clickup_access_proof_configuration_mismatch");
  }
  if (
    proof.workspaceId !== config.workspaceId ||
    proof.spaceId !== config.spaceId ||
    proof.listId !== config.listId
  ) {
    throw new ClickUpConfigurationError("clickup_access_proof_destination_mismatch");
  }
  requiredExactId(proof.principalId, "clickup_principal_unprovisioned");
  const nowMs = (input.now ?? new Date()).getTime();
  const verifiedAtMs = Date.parse(proof.verifiedAt);
  const expiresAtMs = Date.parse(proof.expiresAt);
  if (!Number.isFinite(verifiedAtMs) || !Number.isFinite(expiresAtMs) || verifiedAtMs > nowMs || expiresAtMs <= nowMs) {
    throw new ClickUpConfigurationError("clickup_access_proof_expired");
  }
}

export function assertClickUpProjectionAuthorized(input: {
  projection: ClickUpShadowProjection;
  config: ClickUpDestinationConfig;
  authorization: ClickUpAuthorization;
  now?: Date;
}): void {
  assertApprovalAndProof(input);
  if (input.authorization.readOnly || !input.authorization.externalWritesEnabled) {
    throw new ClickUpConfigurationError("clickup_external_writes_disabled");
  }
  const proof = input.authorization.listAccessProof!;
  if (proof.scope !== "list_read_write" || !proof.endpoints.tasksCreate || !proof.endpoints.tasksUpdate) {
    throw new ClickUpConfigurationError("clickup_list_write_scope_unproven");
  }
  if (input.projection.listId !== input.config.listId) {
    throw new ClickUpConfigurationError("clickup_projection_destination_stale");
  }
}

export function assertClickUpIntakeAuthorized(input: {
  config: ClickUpDestinationConfig;
  authorization: ClickUpAuthorization;
  now?: Date;
}): void {
  assertApprovalAndProof(input);
  if (!input.authorization.intakeEnabled) throw new ClickUpConfigurationError("clickup_intake_disabled");
  if (!input.config.fields.intakeOptIn || !input.config.intakeOptInValue) {
    throw new ClickUpConfigurationError("clickup_intake_marker_unconfigured");
  }
  if (!input.authorization.listAccessProof!.endpoints.tasksRead) {
    throw new ClickUpConfigurationError("clickup_list_read_scope_unproven");
  }
}
