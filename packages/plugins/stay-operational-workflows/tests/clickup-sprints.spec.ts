import { describe, expect, it } from "vitest";
import { selectClickUpWeeklySprints } from "../src/modules/clickup/sprints.js";
import { intakeClickUpTask } from "../src/modules/clickup/sync.js";
import type { ClickUpDestinationConfig, ClickUpIntakeCandidate, ClickUpSprintRepository, WeeklySprint } from "../src/modules/clickup/types.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const intervals: WeeklySprint[] = [
  { id: "s1", companyId, projectId, name: "Sep 7", startDate: "2026-09-07", endDate: "2026-09-14", timezone: "Europe/Berlin" },
  { id: "s2", companyId, projectId, name: "Sep 14", startDate: "2026-09-14", endDate: "2026-09-21", timezone: "Europe/Berlin" },
];
const candidate = (statusId: string, dueDateMs: number | null): ClickUpIntakeCandidate => ({ workspaceId: "w", spaceId: "s", listId: "l", taskId: "task", taskUrl: null, title: "Task", planningSummary: "Summary", statusId, dueDateMs, revision: "1", customFields: { opt: "yes" } });
const select = (item: ClickUpIntakeCandidate, sprints = intervals) => selectClickUpWeeklySprints({ companyId, projectId, candidate: item, configuredInProgressStatusId: "progress", sprints, now: new Date("2026-09-10T12:00:00Z") }).map((s) => s.id);

describe("ClickUp weekly sprint selection", () => {
  it("selects the active sprint for configured in-progress without a due date", () => expect(select(candidate("progress", null))).toEqual(["s1"]));
  it.each([
    ["inside", "2026-09-10T10:00:00Z", ["s1"]],
    ["exact start", "2026-09-06T22:00:00Z", ["s1"]],
    ["exact end belongs to next", "2026-09-13T22:00:00Z", ["s2"]],
    ["outside", "2026-10-01T10:00:00Z", []],
  ])("maps a due date %s with half-open Berlin boundaries", (_name, due, expected) => expect(select(candidate("todo", Date.parse(due)))).toEqual(expected));
  it("deduplicates active and due-date selection of the same sprint", () => expect(select(candidate("progress", Date.parse("2026-09-11T10:00:00Z")))).toEqual(["s1"]));
  it("uses UTC only when timezone is absent", () => expect(select(candidate("todo", Date.parse("2026-09-14T00:00:00Z")), intervals.map((s) => ({ ...s, timezone: null })))).toEqual(["s2"]));
  it.each([
    ["invalid timezone", intervals.map((s) => ({ ...s, timezone: "Mars/Olympus" })), "clickup_sprint_timezone_invalid"],
    ["overlap", [intervals[0]!, { ...intervals[1]!, startDate: "2026-09-13" }], "clickup_sprint_intervals_overlap"],
  ])("rejects %s visibly", (_name, sprints, code) => expect(() => select(candidate("todo", Date.parse("2026-09-10T10:00:00Z")), sprints)).toThrowError(expect.objectContaining({ code })));

  it("keeps one issue identity and one issue-sprint link on replay", async () => {
    const links: Array<{ issueId: string; sprintId: string }> = [];
    const sprintRepo: ClickUpSprintRepository = {
      async listWeeklySprints() { return intervals; },
      async linkIssueToSprints(input) { for (const sprintId of new Set(input.sprintIds)) if (!links.some((x) => x.issueId === input.issueId && x.sprintId === sprintId)) links.push({ issueId: input.issueId, sprintId }); return links.map((x, i) => ({ id: String(i), companyId, projectId, ...x })); },
    };
    let issueCreates = 0;
    let taskLink: any = null;
    const repository: any = { async getByExternalTask() { return taskLink; }, async getByIssue() { return taskLink; }, async recordConflicts() {}, async upsertLink(value: any) { taskLink = { id: "link", ...value }; return taskLink; } };
    const config: ClickUpDestinationConfig = { apiBaseUrl: "https://api.clickup.com/api/v2", tokenSecretId: "secret", workspaceId: "w", spaceId: "s", listId: "l", statuses: { toDo: { id: "todo", name: "to do" }, inProgress: { id: "progress", name: "in progress" }, done: { id: "done", name: "done" } }, ownerAssigneeId: 1, fields: { paperclipIssueId: null, planningSummary: "summary", assigneeDisplay: "assignee", blocker: "blocker", acceptanceSummary: "acceptance", estimateNeeded: null, projectionVersion: null, intakeOptIn: "opt" }, intakeOptInValue: "yes" };
    const authorization: any = { enabled: true, readOnly: false, externalWritesEnabled: true, intakeEnabled: true, exactConfigurationApproval: { status: "accepted", configurationRevisionId: "r", configurationFingerprint: "ignored", interactionId: "i", acceptedAt: "2026-09-01T00:00:00Z" }, listAccessProof: null };
    // Intake authorization validates the fingerprint/proof elsewhere; isolate assignment behavior here.
    authorization.exactConfigurationApproval.configurationFingerprint = (await import("../src/modules/clickup/identity.js")).clickUpConfigurationFingerprint(config);
    authorization.listAccessProof = { workspaceId: "w", spaceId: "s", listId: "l", principalId: "1", configurationFingerprint: authorization.exactConfigurationApproval.configurationFingerprint, verifiedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z", scope: "list_read_write", endpoints: { tasksRead: true, tasksCreate: true, tasksUpdate: true } };
    const input: any = { companyId, projectId, candidate: candidate("progress", Date.parse("2026-09-11T10:00:00Z")), config, authorization, repository, sprints: sprintRepo, now: new Date("2026-09-10T12:00:00Z"), issues: { async createIssue() { issueCreates += 1; return { issueId: "issue", issueIdentifier: "STA-1", issueUrl: "/STA-1" }; } } };
    await intakeClickUpTask(input); await intakeClickUpTask(input);
    expect(issueCreates).toBe(1); expect(links).toEqual([{ issueId: "issue", sprintId: "s1" }]);
  });
});
