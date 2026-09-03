import { ClickUpConfigurationError } from "./config.js";
import type { ClickUpIntakeCandidate, WeeklySprint } from "./types.js";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
function timezoneOrUtc(value: string | null): string {
  const timezone = value?.trim() || "UTC";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(0)); }
  catch { throw new ClickUpConfigurationError("clickup_sprint_timezone_invalid"); }
  return timezone;
}
function localDateAt(instantMs: number, timezone: string): string {
  if (!Number.isFinite(instantMs)) throw new ClickUpConfigurationError("clickup_intake_due_date_invalid");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function validateSprints(sprints: WeeklySprint[], companyId: string, projectId: string): string {
  let timezone: string | null | undefined;
  for (const sprint of sprints) {
    if (sprint.companyId !== companyId || sprint.projectId !== projectId) throw new ClickUpConfigurationError("clickup_sprint_scope_mismatch");
    if (!LOCAL_DATE.test(sprint.startDate) || !LOCAL_DATE.test(sprint.endDate) || sprint.startDate >= sprint.endDate) throw new ClickUpConfigurationError("clickup_sprint_interval_invalid");
    if (timezone === undefined) timezone = sprint.timezone;
    else if ((timezone?.trim() || null) !== (sprint.timezone?.trim() || null)) throw new ClickUpConfigurationError("clickup_sprint_timezone_ambiguous");
  }
  const sorted = [...sprints].sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i]!.startDate < sorted[i - 1]!.endDate) throw new ClickUpConfigurationError("clickup_sprint_intervals_overlap");
  return timezoneOrUtc(timezone ?? null);
}
function sprintAt(sprints: WeeklySprint[], date: string): WeeklySprint | null {
  return sprints.find((sprint) => sprint.startDate <= date && date < sprint.endDate) ?? null;
}
export function selectClickUpWeeklySprints(input: { companyId: string; projectId: string; candidate: ClickUpIntakeCandidate; configuredInProgressStatusId: string; sprints: WeeklySprint[]; now: Date }): WeeklySprint[] {
  const timezone = validateSprints(input.sprints, input.companyId, input.projectId);
  const selected = new Map<string, WeeklySprint>();
  if (input.candidate.statusId === input.configuredInProgressStatusId) {
    const active = sprintAt(input.sprints, localDateAt(input.now.getTime(), timezone));
    if (!active) throw new ClickUpConfigurationError("clickup_active_sprint_missing");
    selected.set(active.id, active);
  }
  if (input.candidate.dueDateMs !== null) {
    const due = sprintAt(input.sprints, localDateAt(input.candidate.dueDateMs, timezone));
    if (due) selected.set(due.id, due);
  }
  return [...selected.values()];
}
