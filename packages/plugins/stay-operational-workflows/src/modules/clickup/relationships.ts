import type { ClickUpApiPort, ClickUpDestinationConfig } from "./types.js";

export class ClickUpRelationshipError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ClickUpRelationshipError";
  }
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function reconcileClickUpRelationships(input: {
  api: ClickUpApiPort;
  config: ClickUpDestinationConfig;
  taskId: string;
  correlationValue: string;
  desiredParentTaskId: string | null;
  desiredDependencyTaskIds: string[];
}): Promise<{ action: "already_current" | "updated"; writes: number }> {
  const before = await input.api.getTask(input.taskId);
  if (!before) throw new ClickUpRelationshipError("clickup_relationship_task_missing");
  if (before.listId !== input.config.listId
    || before.customFields[input.config.fields.paperclipIssueId] !== input.correlationValue) {
    throw new ClickUpRelationshipError("clickup_relationship_identity_mismatch");
  }
  if (before.parentTaskId && !input.desiredParentTaskId) {
    throw new ClickUpRelationshipError("clickup_parent_removal_unsupported");
  }

  let writes = 0;
  if (input.desiredParentTaskId && before.parentTaskId !== input.desiredParentTaskId) {
    await input.api.updateParent(input.taskId, input.desiredParentTaskId);
    writes += 1;
  }

  const desiredDependencies = [...new Set(input.desiredDependencyTaskIds)].sort();
  const existingDependencies = [...new Set(before.dependencyTaskIds)].sort();
  for (const dependencyId of existingDependencies) {
    if (!desiredDependencies.includes(dependencyId)) {
      await input.api.removeDependency(input.taskId, dependencyId);
      writes += 1;
    }
  }
  for (const dependencyId of desiredDependencies) {
    if (!existingDependencies.includes(dependencyId)) {
      await input.api.addDependency(input.taskId, dependencyId);
      writes += 1;
    }
  }

  if (writes === 0) return { action: "already_current", writes: 0 };
  const after = await input.api.getTask(input.taskId);
  if (!after
    || after.parentTaskId !== input.desiredParentTaskId
    || !sameIds(after.dependencyTaskIds, desiredDependencies)) {
    throw new ClickUpRelationshipError("clickup_relationship_readback_mismatch");
  }
  return { action: "updated", writes };
}
