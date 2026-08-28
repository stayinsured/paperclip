import {
  APPROVED_CLICKUP_LIST_TIME_ZONE,
  assertClickUpDestinationConfigured,
  ClickUpConfigurationError,
} from "./config.js";
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

export const CLICKUP_MANAGED_DESCRIPTION_START = "<!-- paperclip-sync:start -->";
export const CLICKUP_MANAGED_DESCRIPTION_END = "<!-- paperclip-sync:end -->";

const DESCRIPTION_FIELDS = {
  issue: "Paperclip issue",
  url: "Paperclip URL",
  owner: "Owner label",
  dueDate: "Due date",
  estimate: "Estimate",
  planning: "Planning summary",
  acceptance: "Acceptance criteria",
  blockers: "Blockers",
  correlation: "paperclip-correlation",
  projection: "paperclip-projection",
  sourceStatus: "Paperclip status",
  forecastSource: "Forecast source",
  forecastRevision: "Forecast revision",
} as const;

function descriptionLine(value: string, key: string): string | null {
  const match = value.match(new RegExp(`^${key}: (.*)$`, "m"));
  return match?.[1]?.trim() || null;
}

function descriptionSection(value: string, key: string, nextKey: string): string | null {
  const match = value.match(new RegExp(`${key}:\\n([\\s\\S]*?)\\n\\n${nextKey}:`));
  const normalized = match?.[1]?.trim() ?? "";
  return normalized && normalized !== "None" ? normalized : null;
}

function managedDescriptionBlock(value: string): string | null {
  const start = value.indexOf(CLICKUP_MANAGED_DESCRIPTION_START);
  const end = value.indexOf(CLICKUP_MANAGED_DESCRIPTION_END);
  if (start === -1 && end === -1) return null;
  if (
    start === -1
    || end < start
    || value.indexOf(CLICKUP_MANAGED_DESCRIPTION_START, start + 1) !== -1
    || value.indexOf(CLICKUP_MANAGED_DESCRIPTION_END, end + 1) !== -1
  ) {
    throw new ClickUpConfigurationError("clickup_managed_description_ambiguous");
  }
  return value.slice(start, end + CLICKUP_MANAGED_DESCRIPTION_END.length);
}

export function mergeClickUpManagedDescription(existing: string, managed: string): string {
  const managedBlock = managedDescriptionBlock(managed);
  if (managedBlock !== managed) {
    throw new ClickUpConfigurationError("clickup_managed_description_invalid");
  }
  const current = managedDescriptionBlock(existing);
  if (!current) return existing ? `${existing}\n\n${managed}` : managed;
  const start = existing.indexOf(CLICKUP_MANAGED_DESCRIPTION_START);
  const end = existing.indexOf(CLICKUP_MANAGED_DESCRIPTION_END) + CLICKUP_MANAGED_DESCRIPTION_END.length;
  return `${existing.slice(0, start)}${managed}${existing.slice(end)}`;
}

export function parseClickUpMirrorDescription(value: string): {
  correlationValue: string | null;
  projectionVersion: string | null;
  planningSummary: string | null;
  assigneeDisplay: string | null;
  blocker: string | null;
  acceptanceSummary: string | null;
  sourceStatus: string | null;
  forecastSource: string | null;
  forecastRevision: string | null;
} {
  const managed = managedDescriptionBlock(value) ?? "";
  return {
    correlationValue: descriptionLine(managed, DESCRIPTION_FIELDS.correlation),
    projectionVersion: descriptionLine(managed, DESCRIPTION_FIELDS.projection),
    planningSummary: descriptionSection(managed, DESCRIPTION_FIELDS.planning, DESCRIPTION_FIELDS.acceptance),
    acceptanceSummary: descriptionSection(managed, DESCRIPTION_FIELDS.acceptance, DESCRIPTION_FIELDS.blockers),
    blocker: descriptionSection(managed, DESCRIPTION_FIELDS.blockers, DESCRIPTION_FIELDS.correlation),
    assigneeDisplay: descriptionLine(managed, DESCRIPTION_FIELDS.owner),
    sourceStatus: descriptionLine(managed, DESCRIPTION_FIELDS.sourceStatus),
    forecastSource: descriptionLine(managed, DESCRIPTION_FIELDS.forecastSource),
    forecastRevision: descriptionLine(managed, DESCRIPTION_FIELDS.forecastRevision),
  };
}

function dueDateMilliseconds(value: string | null): number | null {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ClickUpConfigurationError("clickup_due_date_invalid");
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) throw new ClickUpConfigurationError("clickup_due_date_invalid");
  return milliseconds;
}

const approvedClickUpDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: APPROVED_CLICKUP_LIST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function normalizeClickUpDateOnlyMilliseconds(value: number | null): number | null {
  if (value == null) return null;
  const parts = Object.fromEntries(
    approvedClickUpDateFormatter.formatToParts(new Date(value))
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

function conservativeEstimateHours(source: ApprovedEstimateSource | null): number | null {
  if (!source) throw new ClickUpConfigurationError("clickup_planning_metadata_invalid");
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
): ClickUpStatusKey {
  switch (source.status) {
    case "backlog":
    case "todo":
    case "blocked":
      return "toDo";
    case "in_progress":
    case "in_review":
      return "inProgress";
    case "done":
    case "cancelled":
      return "done";
    default:
      throw new ClickUpConfigurationError("clickup_paperclip_status_unmapped");
  }
}

export function renderClickUpShadowProjection(input: {
  source: ClickUpProjectionSource;
  config: ClickUpDestinationConfig;
  policyVersion: string;
  parentTaskId?: string | null;
  generatedAt?: Date;
}): ClickUpShadowProjection {
  assertClickUpDestinationConfigured(input.config);
  const { source, config } = input;
  if (source.projectId.trim().length === 0 || source.companyId.trim().length === 0) {
    throw new ClickUpConfigurationError("clickup_source_scope_missing");
  }
  if (!input.policyVersion.trim()) throw new ClickUpConfigurationError("clickup_policy_version_missing");

  const statusKey = statusKeyForSource(source);
  const status = config.statuses[statusKey];
  const estimateHours = conservativeEstimateHours(source.approvedEstimate);
  if (!source.dueDate) throw new ClickUpConfigurationError("clickup_planning_metadata_invalid");
  const dueDateMs = dueDateMilliseconds(source.dueDate);
  const forecastSource = source.approvedEstimate!.documentKey;
  const forecastRevision = source.approvedEstimate!.revisionId;
  const rawTitle = redactClickUpText(source.title);
  const title = `[${redactClickUpText(source.issueIdentifier)}] ${rawTitle}`;
  const planningSummary = redactClickUpText(source.planningSummary);
  const assigneeDisplay = source.assigneeDisplayRef ? redactClickUpText(source.assigneeDisplayRef) : null;
  const blocker = source.blockerSummary ? redactClickUpText(source.blockerSummary) : null;
  const acceptanceSummary = redactClickUpText(source.acceptanceSummary);
  if (!rawTitle) throw new ClickUpConfigurationError("clickup_projection_title_empty");
  if (!planningSummary) throw new ClickUpConfigurationError("clickup_projection_summary_empty");

  const ownedSnapshot: ClickUpOwnedSnapshot = {
    title,
    planningSummary,
    status: status.id,
    assigneeDisplay,
    nativeAssignee: config.ownerAssigneeId,
    dueDate: dueDateMs,
    blocker,
    acceptanceSummary,
    estimate: estimateHours,
    sourceStatus: source.status,
    forecastSource,
    forecastRevision,
  };
  const safeUrl = safePaperclipUrl(source.issueUrl);
  const correlationValue = clickUpCorrelationValue(source.issueId, safeUrl);
  const projectionVersion = clickUpProjectionVersion({
    companyId: source.companyId,
    issueId: source.issueId,
    policyVersion: input.policyVersion,
    snapshot: ownedSnapshot,
  });
  const description = [
    CLICKUP_MANAGED_DESCRIPTION_START,
    "Paperclip mirror. Paperclip is authoritative.",
    `${DESCRIPTION_FIELDS.issue}: ${redactClickUpText(source.issueIdentifier)}`,
    `${DESCRIPTION_FIELDS.url}: ${safeUrl}`,
    `${DESCRIPTION_FIELDS.owner}: ${assigneeDisplay ?? "Unassigned"}`,
    `${DESCRIPTION_FIELDS.dueDate}: ${source.dueDate ?? "Not set"}`,
    `${DESCRIPTION_FIELDS.estimate}: ${estimateHours == null ? "Not set" : `${estimateHours} hours`}`,
    `${DESCRIPTION_FIELDS.sourceStatus}: ${source.status}`,
    `${DESCRIPTION_FIELDS.forecastSource}: ${forecastSource}`,
    `${DESCRIPTION_FIELDS.forecastRevision}: ${forecastRevision}`,
    "",
    `${DESCRIPTION_FIELDS.planning}:`,
    planningSummary,
    "",
    `${DESCRIPTION_FIELDS.acceptance}:`,
    acceptanceSummary,
    "",
    `${DESCRIPTION_FIELDS.blockers}:`,
    blocker ?? "None",
    "",
    `${DESCRIPTION_FIELDS.correlation}: ${correlationValue}`,
    `${DESCRIPTION_FIELDS.projection}: ${projectionVersion}`,
    CLICKUP_MANAGED_DESCRIPTION_END,
  ].join("\n");
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
    description,
    statusId: status.id,
    statusName: status.name,
    nativeAssigneeId: config.ownerAssigneeId,
    timeEstimateMs: estimateHours == null ? null : estimateHours * 60 * 60 * 1_000,
    dueDateMs,
    parentTaskId: input.parentTaskId ?? null,
    customFields: {},
    ownedSnapshot,
    sourceUpdatedAt: new Date(source.updatedAt).toISOString(),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  };
}

export function ownedSnapshotFromRemote(
  task: {
    title: string;
    description: string;
    statusId: string;
    assigneeIds: number[];
    timeEstimateMs: number | null;
    dueDateMs: number | null;
    customFields: Record<string, string | boolean | null | undefined>;
  },
  _config: ClickUpDestinationConfig,
): ClickUpOwnedSnapshot {
  const parsed = parseClickUpMirrorDescription(task.description);
  const estimateHours = task.timeEstimateMs == null ? null : task.timeEstimateMs / (60 * 60 * 1_000);
  const nativeAssignee = task.assigneeIds.length === 1 ? task.assigneeIds[0]! : JSON.stringify([...task.assigneeIds].sort());
  return {
    title: redactClickUpText(task.title),
    planningSummary: parsed.planningSummary,
    status: task.statusId,
    assigneeDisplay: parsed.assigneeDisplay,
    blocker: parsed.blocker,
    acceptanceSummary: parsed.acceptanceSummary,
    estimate: estimateHours,
    nativeAssignee,
    dueDate: normalizeClickUpDateOnlyMilliseconds(task.dueDateMs),
    sourceStatus: parsed.sourceStatus,
    forecastSource: parsed.forecastSource,
    forecastRevision: parsed.forecastRevision,
  };
}
