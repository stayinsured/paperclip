import { configurationFingerprint } from "./identity.js";
import type {
  OutlineDestinationConfig,
  OutlinePublishingAuthorization,
  OutlineShadowPreview,
} from "./types.js";

export class OutlinePublishingDeniedError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OutlinePublishingDeniedError";
  }
}

export function outlineConfigurationFingerprint(config: OutlineDestinationConfig): string {
  if (config.accessMode !== "mcp") {
    throw new OutlinePublishingDeniedError("outline_mcp_access_required");
  }
  if (!config.connectionId.trim()) {
    throw new OutlinePublishingDeniedError("outline_mcp_connection_missing");
  }
  const toolNames = Object.values(config.tools);
  if (toolNames.some((tool) => !tool.trim()) || new Set(toolNames).size !== toolNames.length) {
    throw new OutlinePublishingDeniedError("outline_mcp_tool_set_invalid");
  }
  return configurationFingerprint({
    accessMode: config.accessMode,
    connectionId: config.connectionId,
    connectionRevision: config.connectionRevision ?? null,
    tools: config.tools,
    targets: config.targets,
  });
}

export function assertOutlinePublishingAuthorized(input: {
  preview: OutlineShadowPreview;
  destination: OutlineDestinationConfig;
  authorization: OutlinePublishingAuthorization;
  now?: Date;
}): void {
  const { preview, destination, authorization } = input;
  if (!authorization.enabled) {
    throw new OutlinePublishingDeniedError("outline_module_disabled");
  }
  if (authorization.readOnly || !authorization.externalWritesEnabled) {
    throw new OutlinePublishingDeniedError("outline_external_writes_disabled");
  }

  const fingerprint = outlineConfigurationFingerprint(destination);
  const approval = authorization.exactConfigurationApproval;
  if (!approval || approval.status !== "accepted") {
    throw new OutlinePublishingDeniedError("outline_exact_configuration_not_approved");
  }
  if (approval.configurationFingerprint !== fingerprint) {
    throw new OutlinePublishingDeniedError("outline_configuration_changed_after_approval");
  }

  const proof = authorization.writerProofs?.find((candidate) => candidate.collectionId === preview.collectionId);
  if (!proof) {
    throw new OutlinePublishingDeniedError("outline_collection_writer_proof_missing");
  }
  if (proof.configurationFingerprint !== fingerprint) {
    throw new OutlinePublishingDeniedError("outline_writer_proof_configuration_mismatch");
  }
  if (proof.accessMode !== "mcp" || proof.connectionId !== destination.connectionId) {
    throw new OutlinePublishingDeniedError("outline_writer_proof_mcp_connection_mismatch");
  }
  if (proof.permission !== "read_write") {
    throw new OutlinePublishingDeniedError("outline_collection_not_writable");
  }
  if (!proof.allowedParentDocumentIds.includes(preview.parentDocumentId)) {
    throw new OutlinePublishingDeniedError("outline_parent_not_in_writer_proof");
  }
  if (
    proof.tools.documentsInfo !== destination.tools.documentsInfo ||
    proof.tools.documentsCreate !== destination.tools.documentsCreate ||
    proof.tools.documentsUpdate !== destination.tools.documentsUpdate
  ) {
    throw new OutlinePublishingDeniedError("outline_writer_mcp_tool_scope_incomplete");
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const verifiedAtMs = Date.parse(proof.verifiedAt);
  const expiresAtMs = Date.parse(proof.expiresAt);
  if (
    !Number.isFinite(verifiedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    verifiedAtMs > nowMs ||
    expiresAtMs <= nowMs
  ) {
    throw new OutlinePublishingDeniedError("outline_writer_proof_expired");
  }

  const configuredTarget = destination.targets[preview.target];
  if (
    configuredTarget.collectionId !== preview.collectionId ||
    configuredTarget.parentDocumentId !== preview.parentDocumentId
  ) {
    throw new OutlinePublishingDeniedError("outline_preview_destination_stale");
  }
}
