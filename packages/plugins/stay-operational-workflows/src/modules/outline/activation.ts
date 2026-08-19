import { WorkflowRequestError } from "../../contracts.js";
import { outlineConfigurationFingerprint } from "./authorization.js";
import type {
  OutlineCollectionWriterProof,
  OutlineDestinationConfig,
  OutlineModuleActivation,
  OutlinePublishingAuthorization,
  OutlineTarget,
} from "./types.js";

const TARGETS: OutlineTarget[] = ["architecture", "reports", "processes"];

function invalidActivation(message: string): WorkflowRequestError {
  return new WorkflowRequestError(
    422,
    "invalid_workflow_config",
    message,
    "Workflow configuration validation failed",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidActivation(`${field} is required`);
  }
  return value.trim();
}

function parseDestination(input: unknown): OutlineDestinationConfig {
  if (!isObject(input)) throw invalidActivation("outlineActivation.destination is required");
  if (requiredNonEmptyString(input.accessMode, "outlineActivation.destination.accessMode") !== "mcp") {
    throw invalidActivation("outlineActivation.destination.accessMode must be mcp");
  }
  const connectionId = requiredNonEmptyString(input.connectionId, "outlineActivation.destination.connectionId");
  const toolsInput = isObject(input.tools) ? input.tools : {};
  const tools = {
    documentsInfo: requiredNonEmptyString(toolsInput.documentsInfo, "outlineActivation.destination.tools.documentsInfo"),
    documentsCreate: requiredNonEmptyString(toolsInput.documentsCreate, "outlineActivation.destination.tools.documentsCreate"),
    documentsUpdate: requiredNonEmptyString(toolsInput.documentsUpdate, "outlineActivation.destination.tools.documentsUpdate"),
  };
  const toolNames = Object.values(tools);
  if (new Set(toolNames).size !== toolNames.length) {
    throw invalidActivation("outlineActivation.destination.tools must name three distinct tools");
  }
  const targetsInput = isObject(input.targets) ? input.targets : {};
  const targets = {} as OutlineDestinationConfig["targets"];
  for (const target of TARGETS) {
    const targetInput = isObject(targetsInput[target]) ? targetsInput[target] as Record<string, unknown> : null;
    if (!targetInput) {
      throw invalidActivation(`outlineActivation.destination.targets.${target} is required`);
    }
    targets[target] = {
      collectionId: requiredNonEmptyString(targetInput.collectionId, `outlineActivation.destination.targets.${target}.collectionId`),
      parentDocumentId: requiredNonEmptyString(targetInput.parentDocumentId, `outlineActivation.destination.targets.${target}.parentDocumentId`),
      parentTitle: target as OutlineDestinationConfig["targets"][OutlineTarget]["parentTitle"],
    };
  }
  return {
    accessMode: "mcp",
    connectionId,
    connectionRevision: typeof input.connectionRevision === "string" && input.connectionRevision.trim()
      ? input.connectionRevision.trim()
      : null,
    tools,
    targets,
  };
}

function parseAuthorization(input: unknown): OutlinePublishingAuthorization {
  if (!isObject(input)) throw invalidActivation("outlineActivation.authorization is required");
  const approvalInput = isObject(input.exactConfigurationApproval) ? input.exactConfigurationApproval : null;
  let approval: OutlinePublishingAuthorization["exactConfigurationApproval"] = null;
  if (approvalInput) {
    const status = requiredNonEmptyString(approvalInput.status, "outlineActivation.authorization.exactConfigurationApproval.status");
    if (status !== "accepted") {
      throw invalidActivation("outlineActivation.authorization.exactConfigurationApproval.status must be accepted");
    }
    approval = {
      status: "accepted",
      configurationRevisionId: requiredNonEmptyString(approvalInput.configurationRevisionId, "outlineActivation.authorization.exactConfigurationApproval.configurationRevisionId"),
      configurationFingerprint: requiredNonEmptyString(approvalInput.configurationFingerprint, "outlineActivation.authorization.exactConfigurationApproval.configurationFingerprint"),
      interactionId: requiredNonEmptyString(approvalInput.interactionId, "outlineActivation.authorization.exactConfigurationApproval.interactionId"),
      acceptedAt: requiredNonEmptyString(approvalInput.acceptedAt, "outlineActivation.authorization.exactConfigurationApproval.acceptedAt"),
    };
  }
  const proofs = Array.isArray(input.writerProofs)
    ? input.writerProofs.map((proof) => {
      if (!isObject(proof)) throw invalidActivation("outlineActivation.authorization.writerProofs entries must be objects");
      if (requiredNonEmptyString(proof.accessMode, "writerProof.accessMode") !== "mcp") {
        throw invalidActivation("writerProof.accessMode must be mcp");
      }
      if (requiredNonEmptyString(proof.permission, "writerProof.permission") !== "read_write") {
        throw invalidActivation("writerProof.permission must be read_write");
      }
      const allowedParents = Array.isArray(proof.allowedParentDocumentIds)
        ? proof.allowedParentDocumentIds.map((parent) => requiredNonEmptyString(parent, "writerProof.allowedParentDocumentIds entry"))
        : [];
      const proofTools = isObject(proof.tools) ? proof.tools : {};
      return {
        accessMode: "mcp" as const,
        connectionId: requiredNonEmptyString(proof.connectionId, "writerProof.connectionId"),
        collectionId: requiredNonEmptyString(proof.collectionId, "writerProof.collectionId"),
        permission: "read_write" as const,
        allowedParentDocumentIds: allowedParents,
        configurationFingerprint: requiredNonEmptyString(proof.configurationFingerprint, "writerProof.configurationFingerprint"),
        verifiedAt: requiredNonEmptyString(proof.verifiedAt, "writerProof.verifiedAt"),
        expiresAt: requiredNonEmptyString(proof.expiresAt, "writerProof.expiresAt"),
        tools: {
          documentsInfo: requiredNonEmptyString(proofTools.documentsInfo, "writerProof.tools.documentsInfo"),
          documentsCreate: requiredNonEmptyString(proofTools.documentsCreate, "writerProof.tools.documentsCreate"),
          documentsUpdate: requiredNonEmptyString(proofTools.documentsUpdate, "writerProof.tools.documentsUpdate"),
        },
      } satisfies OutlineCollectionWriterProof;
    })
    : undefined;
  return {
    enabled: input.enabled === true,
    readOnly: input.readOnly !== false,
    externalWritesEnabled: input.externalWritesEnabled === true,
    exactConfigurationApproval: approval,
    writerProofs: proofs,
  };
}

export function parseOutlineModuleActivation(input: unknown): OutlineModuleActivation {
  if (!isObject(input)) throw invalidActivation("outlineActivation must be an object");
  if (input.schemaVersion !== 1) throw invalidActivation("outlineActivation.schemaVersion must be 1");
  return {
    schemaVersion: 1,
    destination: parseDestination(input.destination),
    authorization: parseAuthorization(input.authorization),
  };
}

/**
 * Returns the publishing-denial code for an activation payload, or null when
 * every gate currently passes. Mirrors the per-publish gates in
 * authorization.ts so a payload that could never publish is rejected at
 * configuration time and degrades reconciliation to shadow-only at runtime
 * (kill switch, approval drift, proof expiry).
 */
export function outlineActivationDenial(
  activation: OutlineModuleActivation,
  now: Date = new Date(),
): string | null {
  const { destination, authorization } = activation;
  if (!authorization.enabled) return "outline_module_disabled";
  if (authorization.readOnly || !authorization.externalWritesEnabled) {
    return "outline_external_writes_disabled";
  }
  let fingerprint: string;
  try {
    fingerprint = outlineConfigurationFingerprint(destination);
  } catch {
    return "outline_mcp_access_required";
  }
  const approval = authorization.exactConfigurationApproval;
  if (!approval || approval.status !== "accepted") return "outline_exact_configuration_not_approved";
  if (approval.configurationFingerprint !== fingerprint) return "outline_configuration_changed_after_approval";

  const nowMs = now.getTime();
  for (const target of TARGETS) {
    const configuredTarget = destination.targets[target];
    const proof = authorization.writerProofs?.find((candidate) => candidate.collectionId === configuredTarget.collectionId);
    if (!proof) return "outline_collection_writer_proof_missing";
    if (proof.configurationFingerprint !== fingerprint) return "outline_writer_proof_configuration_mismatch";
    if (proof.accessMode !== "mcp" || proof.connectionId !== destination.connectionId) {
      return "outline_writer_proof_mcp_connection_mismatch";
    }
    if (proof.permission !== "read_write") return "outline_collection_not_writable";
    if (!proof.allowedParentDocumentIds.includes(configuredTarget.parentDocumentId)) {
      return "outline_parent_not_in_writer_proof";
    }
    if (
      proof.tools.documentsInfo !== destination.tools.documentsInfo ||
      proof.tools.documentsCreate !== destination.tools.documentsCreate ||
      proof.tools.documentsUpdate !== destination.tools.documentsUpdate
    ) {
      return "outline_writer_mcp_tool_scope_incomplete";
    }
    const verifiedAtMs = Date.parse(proof.verifiedAt);
    const expiresAtMs = Date.parse(proof.expiresAt);
    if (
      !Number.isFinite(verifiedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      verifiedAtMs > nowMs ||
      expiresAtMs <= nowMs
    ) {
      return "outline_writer_proof_expired";
    }
  }
  return null;
}

export function assertOutlineModuleActivationUsable(
  activation: OutlineModuleActivation,
  now: Date = new Date(),
): void {
  const denial = outlineActivationDenial(activation, now);
  if (denial) {
    throw invalidActivation(`Outline activation is not currently usable: ${denial}`);
  }
}
