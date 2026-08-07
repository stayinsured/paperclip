import { clickUpConflictKey } from "./identity.js";
import type {
  ClickUpConflict,
  ClickUpInboundEvent,
  ClickUpOwnedField,
  ClickUpOwnedSnapshot,
  ClickUpTaskLink,
} from "./types.js";

const OWNED_FIELDS: ClickUpOwnedField[] = [
  "title",
  "planningSummary",
  "status",
  "assigneeDisplay",
  "blocker",
  "acceptanceSummary",
  "estimate",
];

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function shouldSuppressClickUpEcho(event: ClickUpInboundEvent, link: ClickUpTaskLink): boolean {
  if (event.taskId !== link.taskId || event.listId !== link.listId) return false;
  const ownActor = Boolean(
    event.actorId &&
    event.connectorServiceAccountId &&
    event.actorId === event.connectorServiceAccountId,
  );
  const ownVersion = Boolean(event.projectionVersion && event.projectionVersion === link.lastProjectionVersion);
  return ownActor || ownVersion;
}

export function detectClickUpOwnedFieldConflicts(input: {
  link: ClickUpTaskLink;
  external: ClickUpOwnedSnapshot;
  paperclip: ClickUpOwnedSnapshot;
  externalUpdatedAt: string;
  paperclipUpdatedAt: string;
  detectedAt?: Date;
}): ClickUpConflict[] {
  const conflicts: ClickUpConflict[] = [];
  for (const field of OWNED_FIELDS) {
    const baseValue = input.link.baseSnapshot[field];
    const externalValue = input.external[field];
    const paperclipValue = input.paperclip[field];
    const externalChanged = !same(externalValue, baseValue);
    if (!externalChanged || same(externalValue, paperclipValue)) continue;

    conflicts.push({
      conflictKey: clickUpConflictKey({
        companyId: input.link.companyId,
        issueId: input.link.issueId,
        field,
        baseValue,
        externalValue,
        paperclipValue,
      }),
      companyId: input.link.companyId,
      projectId: input.link.projectId,
      issueId: input.link.issueId,
      linkId: input.link.id,
      field,
      baseValue,
      externalValue,
      paperclipValue,
      externalUpdatedAt: new Date(input.externalUpdatedAt).toISOString(),
      paperclipUpdatedAt: new Date(input.paperclipUpdatedAt).toISOString(),
      detectedAt: (input.detectedAt ?? new Date()).toISOString(),
      status: "open",
    });
  }
  return conflicts;
}
