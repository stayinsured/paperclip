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
  const url = new URL(config.apiBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new OutlinePublishingDeniedError("outline_api_url_not_https");
  }
  return configurationFingerprint({
    apiBaseUrl: url.toString(),
    tokenSecretId: config.tokenSecretId,
    tokenSecretVersion: config.tokenSecretVersion ?? null,
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
  if (proof.permission !== "read_write") {
    throw new OutlinePublishingDeniedError("outline_collection_not_writable");
  }
  if (!proof.allowedParentDocumentIds.includes(preview.parentDocumentId)) {
    throw new OutlinePublishingDeniedError("outline_parent_not_in_writer_proof");
  }
  if (!proof.endpoints.documentsInfo || !proof.endpoints.documentsCreate || !proof.endpoints.documentsUpdate) {
    throw new OutlinePublishingDeniedError("outline_writer_endpoint_scope_incomplete");
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
