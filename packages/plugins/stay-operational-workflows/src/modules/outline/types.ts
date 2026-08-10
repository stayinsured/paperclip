export type OutlineTarget = "architecture" | "reports" | "processes";
export type OutlineTargetClass = "Architecture" | "Reports" | "Processes" | "none";
export type OutlineMaterialityClassification = "material" | "not_material" | "needs_review";

export interface OutlineCompletionSource {
  companyId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  completedAt: string;
}

export interface OutlineMaterialityAssessment {
  classification: OutlineMaterialityClassification;
  reasonCodes: string[];
  targetClass: OutlineTargetClass;
  canonicalIdentity: {
    assessmentKey: string;
    documentKey: string | null;
    proposedAction: "create" | "update" | "none";
    existingDocumentRef: string | null;
  };
  evidence: Array<{
    kind: "issue" | "commit" | "test" | "metric" | "document";
    sourceRef: string;
    claim: string;
  }>;
  safeDraft: {
    template: "architecture_decision" | "completed_task_outcome" | "operator_process";
    title: string;
    bodyMarkdown: string;
  } | null;
  review: {
    required: boolean;
    questions: string[];
  };
}

export interface OutlineTargetDestination {
  collectionId: string;
  parentDocumentId: string;
  parentTitle: "Architecture" | "Reports" | "Processes";
}

export interface OutlineDestinationConfig {
  accessMode: "mcp";
  connectionId: string;
  connectionRevision?: string | null;
  tools: {
    documentsInfo: string;
    documentsCreate: string;
    documentsUpdate: string;
  };
  targets: Record<OutlineTarget, OutlineTargetDestination>;
}

export interface OutlineShadowPreview {
  schemaVersion: 1;
  assessmentKey: string;
  documentKey: string;
  deterministicDocumentId: string;
  companyId: string;
  sourceIssueId: string;
  sourceIssueIdentifier: string;
  policyVersion: string;
  target: OutlineTarget;
  collectionId: string;
  parentDocumentId: string;
  parentTitle: string;
  title: string;
  body: string;
  bodySha256: string;
  generatedAt: string;
  mode: "shadow";
  wouldPublish: false;
}

export interface OutlineExactConfigurationApproval {
  status: "accepted";
  configurationRevisionId: string;
  configurationFingerprint: string;
  interactionId: string;
  acceptedAt: string;
}

export interface OutlineCollectionWriterProof {
  accessMode: "mcp";
  connectionId: string;
  collectionId: string;
  permission: "read_write";
  allowedParentDocumentIds: string[];
  configurationFingerprint: string;
  verifiedAt: string;
  expiresAt: string;
  tools: {
    documentsInfo: string;
    documentsCreate: string;
    documentsUpdate: string;
  };
}

export interface OutlinePublishingAuthorization {
  enabled: boolean;
  readOnly: boolean;
  externalWritesEnabled: boolean;
  exactConfigurationApproval?: OutlineExactConfigurationApproval | null;
  writerProofs?: OutlineCollectionWriterProof[];
}

export interface OutlineDocument {
  id: string;
  collectionId: string;
  parentDocumentId: string | null;
  title: string;
  text: string;
  url?: string | null;
  updatedAt?: string | null;
}

export interface OutlineMcpPort {
  getDocument(id: string): Promise<OutlineDocument | null>;
  createDocument(input: {
    id: string;
    collectionId: string;
    parentDocumentId: string;
    title: string;
    text: string;
  }): Promise<OutlineDocument>;
  updateDocument(input: {
    id: string;
    title: string;
    text: string;
  }): Promise<OutlineDocument>;
}

export type OutlinePublishAction = "created" | "updated" | "already_current" | "failed";

export interface OutlinePublishReceipt {
  schemaVersion: 1;
  operationKey: string;
  exceptionKey: string;
  companyId: string;
  sourceIssueId: string;
  policyVersion: string;
  target: OutlineTarget;
  documentId: string;
  collectionId: string;
  parentDocumentId: string;
  bodySha256: string;
  action: OutlinePublishAction;
  outcome: "succeeded" | "retryable_failure" | "terminal_failure";
  errorClass?: string | null;
  retryAfterMs?: number | null;
  reconciledBeforeRetry: boolean;
  sourceIssueMutation: "none";
  occurredAt: string;
}
