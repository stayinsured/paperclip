import { describe, expect, it } from "vitest";
import { assertLiveIssueDag, validateLiveIssueDag } from "./live-issue-dag.js";

describe("validateLiveIssueDag", () => {
  it("accepts a completed, reconciled parent-last DAG", () => {
    expect(validateLiveIssueDag([
      { id: "root", parentId: null, status: "in_progress", blockedByIssueIds: [] },
      { id: "child", parentId: "root", status: "done", blockedByIssueIds: [], requiredIntegrations: ["clickup"], healthyIntegrations: ["clickup"] },
    ])).toEqual([]);
  });

  it("reports missing blockers, cycles, premature completion, stale roots, and impossible hierarchy waits", () => {
    const codes = validateLiveIssueDag([
      { id: "root", parentId: null, status: "blocked", blockedByIssueIds: ["finished"] },
      { id: "finished", parentId: "root", status: "done", blockedByIssueIds: ["leaf"] },
      { id: "leaf", parentId: "finished", status: "in_progress", blockedByIssueIds: ["finished"] },
      { id: "a", parentId: null, status: "todo", blockedByIssueIds: ["b"] },
      { id: "b", parentId: null, status: "todo", blockedByIssueIds: ["a"] },
      { id: "named-missing", parentId: null, status: "todo", blockedByIssueIds: ["absent"] },
      { id: "orphan", parentId: "missing", status: "blocked", blockedByIssueIds: [] },
    ]).map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining([
      "stale_root_blocker",
      "premature_parent_completion",
      "impossible_hierarchy_dependency",
      "dependency_cycle",
      "missing_parent",
      "missing_blocker",
      "blocked_without_live_blocker",
    ]));
  });

  it("rejects invalid live DAGs with structured findings", () => {
    expect(() => assertLiveIssueDag([
      { id: "blocked", parentId: null, status: "blocked", blockedByIssueIds: [] },
    ])).toThrowError(expect.objectContaining({ message: "live_issue_dag_invalid" }));
  });

  it("reports terminal children whose required integration is not healthy", () => {
    expect(validateLiveIssueDag([{ id: "child", parentId: null, status: "done", blockedByIssueIds: [], requiredIntegrations: ["clickup"], healthyIntegrations: [] }]))
      .toContainEqual({ code: "terminal_integration_pending", issueId: "child", relatedIssueIds: ["clickup"] });
  });
});
