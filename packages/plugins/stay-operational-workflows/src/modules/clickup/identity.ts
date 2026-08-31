import { createHash } from "node:crypto";
import type { ClickUpDestinationConfig, ClickUpOwnedSnapshot } from "./types.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function clickUpSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function clickUpConfigurationFingerprint(config: ClickUpDestinationConfig): string {
  return `sha256:${clickUpSha256(stableJson({
    apiBaseUrl: config.apiBaseUrl,
    tokenSecretId: config.tokenSecretId,
    tokenSecretVersion: config.tokenSecretVersion ?? null,
    workspaceId: config.workspaceId,
    spaceId: config.spaceId,
    listId: config.listId,
    statuses: config.statuses,
    ownerAssigneeId: config.ownerAssigneeId,
  }))}`;
}

export function clickUpCorrelationValue(issueId: string, issueUrl: string): string {
  return `paperclip_issue_id=${issueId};paperclip_url=${issueUrl}`;
}

export function clickUpProjectionVersion(input: {
  companyId: string;
  issueId: string;
  policyVersion: string;
  snapshot: ClickUpOwnedSnapshot;
}): string {
  return `pcv1:${clickUpSha256(stableJson(input))}`;
}

export function clickUpOperationKey(companyId: string, issueId: string): string {
  return `clickup-projection:${clickUpSha256(`${companyId}\u0000${issueId}`)}`;
}

export function clickUpIntakeKey(companyId: string, listId: string, taskId: string): string {
  return `clickup-intake:${clickUpSha256(`${companyId}\u0000${listId}\u0000${taskId}`)}`;
}

export function clickUpConflictKey(input: {
  companyId: string;
  issueId: string;
  field: string;
  baseValue: unknown;
  externalValue: unknown;
  paperclipValue: unknown;
}): string {
  return `clickup-conflict:${clickUpSha256(stableJson(input))}`;
}
