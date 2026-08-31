export type PaperclipProjectionStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type ClickUpStatusKey = "toDo" | "inProgress" | "done";

export interface ClickUpConfiguredStatus {
  id: string;
  name: string;
}

export interface ClickUpFieldIds {
  paperclipIssueId: string | null;
  planningSummary: string | null;
  assigneeDisplay: string | null;
  blocker: string | null;
  acceptanceSummary: string | null;
  estimateNeeded: string | null;
  projectionVersion: string | null;
  intakeOptIn: string | null;
}

export interface ClickUpDestinationConfig {
  apiBaseUrl: string;
  tokenSecretId: string;
  tokenSecretVersion?: number | "latest" | null;
  workspaceId: string;
  spaceId: string;
  listId: string;
  statuses: Record<ClickUpStatusKey, ClickUpConfiguredStatus>;
  ownerAssigneeId: number;
  fields?: ClickUpFieldIds;
  intakeOptInValue?: string | null;
}

export interface ClickUpSecretRef {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
}

export interface ClickUpModuleActivation {
  schemaVersion: 1;
  paperclipBaseUrl: string;
  tokenRef: ClickUpSecretRef;
  destination: ClickUpDestinationConfig;
  authorization: ClickUpAuthorization;
}

export interface ClickUpAcceptedConfigurationApproval {
  status: "accepted";
  configurationRevisionId: string;
  configurationFingerprint: string;
  interactionId: string;
  acceptedAt: string;
}

export interface ClickUpListAccessProof {
  workspaceId: string;
  spaceId: string;
  listId: string;
  principalId: string;
  configurationFingerprint: string;
  verifiedAt: string;
  expiresAt: string;
  scope: "list_read" | "list_read_write";
  endpoints: {
    tasksRead: true;
    tasksCreate: boolean;
    tasksUpdate: boolean;
    customFieldsRead?: boolean;
    dependenciesRead?: boolean;
    dependenciesCreate?: boolean;
    dependenciesDelete?: boolean;
  };
}

export interface ClickUpAuthorization {
  enabled: boolean;
  readOnly: boolean;
  externalWritesEnabled: boolean;
  intakeEnabled: boolean;
  exactConfigurationApproval?: ClickUpAcceptedConfigurationApproval | null;
  listAccessProof?: ClickUpListAccessProof | null;
}

export interface ApprovedEstimateSource {
  documentKey: "plan" | "cto-refinement";
  revisionId: string;
  accepted: true;
  isLatestAccepted: true;
  upperBound: number;
  unit: "hours" | "person_days";
}

export interface ClickUpProjectionSource {
  companyId: string;
  projectId: string;
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  title: string;
  planningSummary: string;
  status: PaperclipProjectionStatus;
  assigneeDisplayRef: string | null;
  blockerSummary: string | null;
  acceptanceSummary: string;
  approvedEstimate: ApprovedEstimateSource | null;
  dueDate: string | null;
  updatedAt: string;
}

export type ClickUpOwnedField =
  | "title"
  | "planningSummary"
  | "status"
  | "assigneeDisplay"
  | "blocker"
  | "acceptanceSummary"
  | "estimate"
  | "nativeAssignee"
  | "dueDate"
  | "sourceStatus"
  | "forecastSource"
  | "forecastRevision";

export type ClickUpOwnedSnapshot = Record<ClickUpOwnedField, string | number | boolean | null>;

export interface ClickUpShadowProjection {
  schemaVersion: 1;
  mode: "shadow";
  wouldWrite: false;
  companyId: string;
  projectId: string;
  issueId: string;
  issueIdentifier: string;
  listId: string;
  correlationValue: string;
  projectionVersion: string;
  title: string;
  description: string;
  statusId: string;
  statusName: string;
  nativeAssigneeId: number;
  timeEstimateMs: number | null;
  dueDateMs: number | null;
  parentTaskId: string | null;
  customFields: Record<string, string | boolean | null>;
  ownedSnapshot: ClickUpOwnedSnapshot;
  sourceUpdatedAt: string;
  generatedAt: string;
}

export interface ClickUpRemoteTask {
  id: string;
  listId: string;
  url: string | null;
  revision: string | null;
  title: string;
  description: string;
  correlationValue: string | null;
  projectionVersion: string | null;
  statusId: string;
  assigneeIds: number[];
  timeEstimateMs: number | null;
  dueDateMs: number | null;
  dueDateTime: boolean;
  customFields: Record<string, string | boolean | null | undefined>;
  parentTaskId: string | null;
  dependencyTaskIds: string[];
  updatedAt: string;
}

export interface ClickUpTaskLink {
  id: string;
  companyId: string;
  projectId: string;
  issueId: string;
  listId: string;
  taskId: string;
  taskUrl: string | null;
  originSide: "paperclip" | "clickup";
  correlationValueHash: string;
  baseSnapshot: ClickUpOwnedSnapshot;
  lastProjectionVersion: string;
  lastExternalRevision: string | null;
  status: "healthy" | "conflict" | "error";
  lastProjectedAt: string | null;
  lastReconciledAt: string | null;
}

export interface ClickUpConflict {
  conflictKey: string;
  companyId: string;
  projectId: string;
  issueId: string;
  linkId: string;
  field: ClickUpOwnedField;
  baseValue: ClickUpOwnedSnapshot[ClickUpOwnedField];
  externalValue: ClickUpOwnedSnapshot[ClickUpOwnedField];
  paperclipValue: ClickUpOwnedSnapshot[ClickUpOwnedField];
  externalUpdatedAt: string;
  paperclipUpdatedAt: string;
  detectedAt: string;
  status: "open";
}

export interface ClickUpInboundEvent {
  taskId: string;
  listId: string;
  actorId: string | null;
  connectorServiceAccountId: string | null;
  projectionVersion: string | null;
}

export interface ClickUpIntakeCandidate {
  workspaceId: string;
  spaceId: string;
  listId: string;
  taskId: string;
  taskUrl: string | null;
  title: string;
  planningSummary: string;
  statusId: string;
  revision: string | null;
  customFields: Record<string, string | boolean | null | undefined>;
}

export interface ClickUpApiPort {
  findTasksByCorrelation(input: {
    listId: string;
    correlationValue: string;
  }): Promise<ClickUpRemoteTask[]>;
  getTask(taskId: string): Promise<ClickUpRemoteTask | null>;
  createTask(input: ClickUpShadowProjection): Promise<ClickUpRemoteTask>;
  updateTask(taskId: string, input: ClickUpShadowProjection): Promise<ClickUpRemoteTask>;
  updateParent(taskId: string, parentTaskId: string): Promise<void>;
  addDependency(taskId: string, dependsOnTaskId: string): Promise<void>;
  removeDependency(taskId: string, dependsOnTaskId: string): Promise<void>;
}

export interface ClickUpLinkRepository {
  getByIssue(companyId: string, issueId: string): Promise<ClickUpTaskLink | null>;
  getByExternalTask(companyId: string, listId: string, taskId: string): Promise<ClickUpTaskLink | null>;
  upsertLink(input: Omit<ClickUpTaskLink, "id">): Promise<ClickUpTaskLink>;
  recordConflicts(conflicts: ClickUpConflict[]): Promise<void>;
}

export interface PaperclipIssueIntakePort {
  createIssue(input: {
    companyId: string;
    projectId: string;
    idempotencyKey: string;
    title: string;
    description: string;
    originId: string;
    originFingerprint: string;
  }): Promise<{ issueId: string; issueIdentifier: string; issueUrl: string }>;
}
