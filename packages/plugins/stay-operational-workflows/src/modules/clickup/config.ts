import { clickUpConfigurationFingerprint } from "./identity.js";
import type {
  ClickUpAuthorization,
  ClickUpDestinationConfig,
  ClickUpModuleActivation,
  ClickUpShadowProjection,
} from "./types.js";

export const APPROVED_CLICKUP_API_BASE_URL = "https://api.clickup.com/api/v2";
export const APPROVED_CLICKUP_WORKSPACE_ID = "90151122957";
export const APPROVED_CLICKUP_LIST_ID = "901511200089";
export const APPROVED_CLICKUP_LIST_TIME_ZONE = "Europe/Berlin";

const REQUIRED_STATUS_NAMES = {
  toDo: "to do",
  inProgress: "in progress",
  done: "done",
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

  if (!Number.isSafeInteger(config.ownerAssigneeId) || config.ownerAssigneeId <= 0) {
    throw new ClickUpConfigurationError("clickup_owner_assignee_id_missing");
  }

  if (config.fields) {
    const configuredFields = Object.values(config.fields).filter((value): value is string => value != null);
    if (configuredFields.length > 0) {
      throw new ClickUpConfigurationError("clickup_custom_fields_not_approved");
    }
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
  if (proof.principalId !== String(config.ownerAssigneeId)) {
    throw new ClickUpConfigurationError("clickup_owner_assignee_proof_mismatch");
  }
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
  const fields = input.config.fields;
  if (
    !fields?.intakeOptIn
    || !fields.planningSummary
    || !fields.assigneeDisplay
    || !fields.blocker
    || !fields.acceptanceSummary
    || !input.config.intakeOptInValue
  ) {
    throw new ClickUpConfigurationError("clickup_intake_marker_unconfigured");
  }
  if (!input.authorization.listAccessProof!.endpoints.tasksRead) {
    throw new ClickUpConfigurationError("clickup_list_read_scope_unproven");
  }
}


function activationObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClickUpConfigurationError(code);
  }
  return value as Record<string, unknown>;
}

export function parseClickUpModuleActivation(value: unknown): ClickUpModuleActivation {
  const root = activationObject(value, "clickup_activation_invalid");
  if (root.schemaVersion !== 1) throw new ClickUpConfigurationError("clickup_activation_version_invalid");
  const tokenRef = activationObject(root.tokenRef, "clickup_secret_ref_missing");
  const destination = activationObject(root.destination, "clickup_destination_missing") as unknown as ClickUpDestinationConfig;
  const authorization = activationObject(root.authorization, "clickup_authorization_missing") as unknown as ClickUpAuthorization;
  if (tokenRef.type !== "secret_ref" || typeof tokenRef.secretId !== "string" || !tokenRef.secretId.trim()) {
    throw new ClickUpConfigurationError("clickup_secret_ref_invalid");
  }
  const tokenRefVersion = typeof tokenRef.version === "number" || tokenRef.version === "latest"
    ? tokenRef.version
    : undefined;
  if (tokenRef.version != null && tokenRefVersion === undefined) {
    throw new ClickUpConfigurationError("clickup_secret_ref_invalid");
  }
  if (tokenRef.secretId !== destination.tokenSecretId
    || (tokenRefVersion ?? null) !== (destination.tokenSecretVersion ?? null)) {
    throw new ClickUpConfigurationError("clickup_secret_ref_destination_mismatch");
  }
  let paperclipBaseUrl: URL;
  try {
    paperclipBaseUrl = new URL(String(root.paperclipBaseUrl ?? ""));
  } catch {
    throw new ClickUpConfigurationError("clickup_paperclip_base_url_invalid");
  }
  if (!['http:', 'https:'].includes(paperclipBaseUrl.protocol)
    || paperclipBaseUrl.username || paperclipBaseUrl.password || paperclipBaseUrl.search || paperclipBaseUrl.hash) {
    throw new ClickUpConfigurationError("clickup_paperclip_base_url_invalid");
  }
  const activation: ClickUpModuleActivation = {
    schemaVersion: 1,
    paperclipBaseUrl: paperclipBaseUrl.toString(),
    tokenRef: {
      type: "secret_ref",
      secretId: tokenRef.secretId.trim(),
      ...(tokenRefVersion === undefined ? {} : { version: tokenRefVersion }),
    },
    destination,
    authorization,
  };
  assertClickUpModuleActivationUsable(activation);
  return activation;
}

export function assertClickUpModuleActivationUsable(
  activation: ClickUpModuleActivation,
  now = new Date(),
): void {
  const { destination, authorization } = activation;
  assertClickUpDestinationConfigured(destination);
  const apiBase = new URL(destination.apiBaseUrl);
  const normalizedApiBase = `${apiBase.origin}${apiBase.pathname.replace(/\/+$/, "")}`;
  if (apiBase.search || apiBase.hash || normalizedApiBase !== APPROVED_CLICKUP_API_BASE_URL) {
    throw new ClickUpConfigurationError("clickup_api_url_outside_approved_boundary");
  }
  if (activation.tokenRef.secretId !== destination.tokenSecretId
    || (activation.tokenRef.version ?? null) !== (destination.tokenSecretVersion ?? null)) {
    throw new ClickUpConfigurationError("clickup_secret_ref_destination_mismatch");
  }
  if (destination.workspaceId !== APPROVED_CLICKUP_WORKSPACE_ID
    || destination.listId !== APPROVED_CLICKUP_LIST_ID) {
    throw new ClickUpConfigurationError("clickup_destination_outside_approved_boundary");
  }
  if (authorization.intakeEnabled) {
    throw new ClickUpConfigurationError("clickup_reverse_intake_not_approved");
  }
  assertApprovalAndProof({ config: destination, authorization, now });
  if (authorization.readOnly || !authorization.externalWritesEnabled) {
    throw new ClickUpConfigurationError("clickup_external_writes_disabled");
  }
  const proof = authorization.listAccessProof!;
  if (proof.scope !== "list_read_write"
    || !proof.endpoints.tasksRead
    || !proof.endpoints.tasksCreate
    || !proof.endpoints.tasksUpdate
    || !proof.endpoints.dependenciesRead
    || !proof.endpoints.dependenciesCreate
    || !proof.endpoints.dependenciesDelete) {
    throw new ClickUpConfigurationError("clickup_full_mirror_scope_unproven");
  }
}
