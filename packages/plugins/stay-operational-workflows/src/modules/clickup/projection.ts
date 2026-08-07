import { assertClickUpDestinationConfigured, ClickUpConfigurationError } from "./config.js";
import { clickUpCorrelationValue, clickUpProjectionVersion } from "./identity.js";
import type {
  ApprovedEstimateSource,
  ClickUpDestinationConfig,
  ClickUpOwnedSnapshot,
  ClickUpProjectionSource,
  ClickUpShadowProjection,
  ClickUpStatusKey,
} from "./types.js";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi;
const URL_PATTERN = /https?:\/\/[^\s<>)\]]+/gi;

export function redactClickUpText(value: string): string {
  const redacted = value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(/\u0000/g, "");
  return redacted.replace(URL_PATTERN, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "[redacted-url]";
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[redacted-url]";
    }
  }).trim();
}

function safePaperclipUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClickUpConfigurationError("clickup_paperclip_url_invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ClickUpConfigurationError("clickup_paperclip_url_invalid");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function conservativeEstimateHours(source: ApprovedEstimateSource | null): number | null {
  if (!source) return null;
  if (source.accepted !== true || source.isLatestAccepted !== true || (source.documentKey !== "plan" && source.documentKey !== "cto-refinement")) {
    throw new ClickUpConfigurationError("clickup_estimate_source_not_approved");
  }
  if (!source.revisionId.trim()) throw new ClickUpConfigurationError("clickup_estimate_revision_missing");
  if (!Number.isFinite(source.upperBound) || source.upperBound <= 0) {
    throw new ClickUpConfigurationError("clickup_estimate_upper_bound_invalid");
  }
  const hours = source.unit === "person_days" ? source.upperBound * 8 : source.upperBound;
  return Math.ceil(hours / 4) * 4;
}

function statusKeyForSource(
  source: ClickUpProjectionSource,
  config: ClickUpDestinationConfig,
  previousProjectedStatusId?: string | null,
): ClickUpStatusKey {
  switch (source.status) {
    case "backlog":
    case "todo":
      return "toDo";
    case "in_progress":
      return "inProgress";
    case "in_review":
      return "readyForQa";
    case "done":
      return "complete";
    case "blocked": { // Blocked retains the last projected lane and uses the protected blocker field.
      if (!source.blockerSummary?.trim()) throw new ClickUpConfigurationError("clickup_blocked_summary_missing");
      const match = Object.entries(config.statuses).find(([, status]) => status.id === previousProjectedStatusId);
      if (!match) throw new ClickUpConfigurationError("clickup_blocked_previous_status_missing");
      return match[0] as ClickUpStatusKey;
    }
    default:
      throw new ClickUpConfigurationError("clickup_paperclip_status_unmapped");
  }
}

export function renderClickUpShadowProjection(input: {
  source: ClickUpProjectionSource;
  config: ClickUpDestinationConfig;
  policyVersion: string;
  previousProjectedStatusId?: string | null;
  generatedAt?: Date;
}): ClickUpShadowProjection {
  assertClickUpDestinationConfigured(input.config);
  const { source, config } = input;
  if (source.projectId.trim().length === 0 || source.companyId.trim().length === 0) {
    throw new ClickUpConfigurationError("clickup_source_scope_missing");
  }
  if (!input.policyVersion.trim()) throw new ClickUpConfigurationError("clickup_policy_version_missing");

  const statusKey = statusKeyForSource(source, config, input.previousProjectedStatusId);
  const status = config.statuses[statusKey];
  const estimateHours = conservativeEstimateHours(source.approvedEstimate);
  const title = redactClickUpText(source.title);
  const planningSummary = redactClickUpText(source.planningSummary);
  const assigneeDisplay = source.assigneeDisplayRef ? redactClickUpText(source.assigneeDisplayRef) : null;
  const blocker = source.blockerSummary ? redactClickUpText(source.blockerSummary) : null;
  const acceptanceSummary = redactClickUpText(source.acceptanceSummary);
  if (!title) throw new ClickUpConfigurationError("clickup_projection_title_empty");
  if (!planningSummary) throw new ClickUpConfigurationError("clickup_projection_summary_empty");

  const ownedSnapshot: ClickUpOwnedSnapshot = {
    title,
    planningSummary,
    status: status.id,
    assigneeDisplay,
    blocker,
    acceptanceSummary,
    estimate: estimateHours,
  };
  const safeUrl = safePaperclipUrl(source.issueUrl);
  const correlationValue = clickUpCorrelationValue(source.issueId, safeUrl);
  const projectionVersion = clickUpProjectionVersion({
    companyId: source.companyId,
    issueId: source.issueId,
    policyVersion: input.policyVersion,
    snapshot: ownedSnapshot,
  });

  return {
    schemaVersion: 1,
    mode: "shadow",
    wouldWrite: false,
    companyId: source.companyId,
    projectId: source.projectId,
    issueId: source.issueId,
    issueIdentifier: source.issueIdentifier,
    listId: config.listId,
    correlationValue,
    projectionVersion,
    title,
    statusId: status.id,
    statusName: status.name,
    timeEstimateMs: estimateHours == null ? null : estimateHours * 60 * 60 * 1_000,
    customFields: {
      [config.fields.paperclipIssueId]: correlationValue,
      [config.fields.planningSummary]: planningSummary,
      [config.fields.assigneeDisplay]: assigneeDisplay,
      [config.fields.blocker]: blocker,
      [config.fields.acceptanceSummary]: acceptanceSummary,
      [config.fields.estimateNeeded]: estimateHours == null,
      [config.fields.projectionVersion]: projectionVersion,
    },
    ownedSnapshot,
    sourceUpdatedAt: new Date(source.updatedAt).toISOString(),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  };
}

export function ownedSnapshotFromRemote(
  task: {
    title: string;
    statusId: string;
    timeEstimateMs: number | null;
    customFields: Record<string, string | boolean | null | undefined>;
  },
  config: ClickUpDestinationConfig,
): ClickUpOwnedSnapshot {
  const field = (id: string): string | boolean | null => task.customFields[id] ?? null;
  const estimateHours = task.timeEstimateMs == null ? null : task.timeEstimateMs / (60 * 60 * 1_000);
  return {
    title: redactClickUpText(task.title),
    planningSummary: typeof field(config.fields.planningSummary) === "string"
      ? redactClickUpText(String(field(config.fields.planningSummary)))
      : null,
    status: task.statusId,
    assigneeDisplay: typeof field(config.fields.assigneeDisplay) === "string"
      ? redactClickUpText(String(field(config.fields.assigneeDisplay)))
      : null,
    blocker: typeof field(config.fields.blocker) === "string"
      ? redactClickUpText(String(field(config.fields.blocker)))
      : null,
    acceptanceSummary: typeof field(config.fields.acceptanceSummary) === "string"
      ? redactClickUpText(String(field(config.fields.acceptanceSummary)))
      : null,
    estimate: estimateHours,
  };
}
