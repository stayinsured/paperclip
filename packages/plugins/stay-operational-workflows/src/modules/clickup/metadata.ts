import type { Issue, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import type { ApprovedEstimateSource } from "./types.js";

export interface ClickUpDeliveryMetadata {
  plannedOwner: string | null;
  approvedEstimate: ApprovedEstimateSource | null;
  dueDate: string | null;
}

const PROVISIONED_PLAN = /Provisioned from [A-Z]+-\d+ approved plan revision (\d+) \(Gate 1 accepted \d{4}-\d{2}-\d{2}\)\./i;
const PLANNED_OWNER = /^Planned owner:\s*(.+?)\.?\s*$/mi;
const ESTIMATE_AND_DUE = /^Estimate:\s*(\d+(?:\.\d+)?)\s*(person-days?|person_days|hours?)(?:[^;\n]*);\s*due\s+(\d{4}-\d{2}-\d{2})/mi;
const PLANNING_METADATA_SECTION = /(?:^|\n)## Planning metadata\s*\n([\s\S]*?)(?=\n##\s|$)/i;
const BOOTSTRAP_EFFORT = /^- Upper-bound effort:\s*(\d+(?:\.\d+)?)\s*(person-days?|person_days|hours?)\./mi;
const BOOTSTRAP_FORECAST = /^- Forecast:\s*(\d{4}-\d{2}-\d{2})\.\s*Calibration revision:\s*(\d{4}-\d{2}-\d{2})\./mi;

function parsedEstimate(
  upperBoundValue: string,
  unitValue: string,
  source: Pick<ApprovedEstimateSource, "documentKey" | "revisionId">,
): ApprovedEstimateSource | null {
  const upperBound = Number(upperBoundValue);
  if (!Number.isFinite(upperBound) || upperBound <= 0 || !source.revisionId.trim()) return null;
  return {
    ...source,
    accepted: true,
    isLatestAccepted: true,
    upperBound,
    unit: unitValue.toLowerCase().startsWith("person") ? "person_days" : "hours",
  };
}

function bootstrapPlanningMetadata(description: string): Omit<ClickUpDeliveryMetadata, "plannedOwner"> | null {
  const section = description.match(PLANNING_METADATA_SECTION)?.[1];
  if (!section) return null;
  const effort = section.match(BOOTSTRAP_EFFORT);
  const forecast = section.match(BOOTSTRAP_FORECAST);
  if (!effort || !forecast) return null;
  const approvedEstimate = parsedEstimate(effort[1]!, effort[2]!, {
    documentKey: "cto-refinement",
    revisionId: forecast[2]!,
  });
  return approvedEstimate ? { approvedEstimate, dueDate: forecast[1]! } : null;
}

export function acceptedClickUpDeliveryMetadata(input: {
  issue: Issue;
  planDocument: IssueDocument | null;
  interactions: IssueThreadInteraction[];
}): ClickUpDeliveryMetadata {
  const description = input.issue.description ?? "";
  const plannedOwner = description.match(PLANNED_OWNER)?.[1]?.trim() ?? null;
  const bootstrap = bootstrapPlanningMetadata(description);
  if (bootstrap) return { plannedOwner, ...bootstrap };

  const binding = description.match(PROVISIONED_PLAN);
  const estimate = description.match(ESTIMATE_AND_DUE);
  if (!binding || !estimate || !input.issue.parentId || !input.planDocument) {
    return { plannedOwner, approvedEstimate: null, dueDate: null };
  }

  const revisionNumber = Number(binding[1]);
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber <= 0) {
    return { plannedOwner, approvedEstimate: null, dueDate: null };
  }
  if (input.planDocument.latestRevisionNumber !== revisionNumber) {
    return { plannedOwner, approvedEstimate: null, dueDate: null };
  }
  const revisionId = input.planDocument.latestRevisionId;
  if (!revisionId) return { plannedOwner, approvedEstimate: null, dueDate: null };

  const accepted = input.interactions.some((interaction) => {
    if (interaction.kind !== "request_confirmation" || interaction.status !== "accepted") return false;
    const target = interaction.payload.target;
    return (
      target?.type === "issue_document"
      && target.issueId === input.issue.parentId
      && target.key === "plan"
      && target.revisionId === revisionId
      && (target.revisionNumber == null || target.revisionNumber === revisionNumber)
    );
  });
  if (!accepted) return { plannedOwner, approvedEstimate: null, dueDate: null };

  const approvedEstimate = parsedEstimate(estimate[1]!, estimate[2]!, {
    documentKey: "plan",
    revisionId,
  });
  if (!approvedEstimate) return { plannedOwner, approvedEstimate: null, dueDate: null };
  return {
    plannedOwner,
    dueDate: estimate[3]!,
    approvedEstimate,
  };
}
