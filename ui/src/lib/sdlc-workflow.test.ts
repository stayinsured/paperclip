import { describe, expect, it } from "vitest";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";
import {
  deriveSdlcWorkflowSummary,
  extractSdlcAcceptanceCriteria,
  extractSdlcPlanningMetadata,
  parseSdlcEvidenceRegistry,
  type SdlcEvidenceRecord,
} from "./sdlc-workflow";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "root",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "SDLC rollout",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: "STA-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    planDocument: {
      id: "plan-doc",
      companyId: "company-1",
      issueId: "root",
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan",
      latestRevisionId: "plan-rev-2",
      latestRevisionNumber: 2,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      lockedAt: null,
      lockedByAgentId: null,
      lockedByUserId: null,
      createdAt: new Date("2026-08-28T00:00:00Z"),
      updatedAt: new Date("2026-08-28T00:00:00Z"),
    },
    createdAt: new Date("2026-08-28T00:00:00Z"),
    updatedAt: new Date("2026-08-28T00:00:00Z"),
    ...overrides,
  };
}

function record(type: string, fields: Record<string, unknown> = {}): SdlcEvidenceRecord {
  return {
    id: `evd:${type}:${String(fields.idSuffix ?? "1")}`,
    type,
    companyId: "company-1",
    issueId: "root",
    createdAt: String(fields.createdAt ?? "2026-08-28T00:00:00Z"),
    ...fields,
  };
}

function gateInteraction(input: {
  gate: "plan" | "start";
  status: "pending" | "accepted" | "rejected";
  reason?: string;
  revisionId?: string;
  graphRev?: string;
}): IssueThreadInteraction {
  const revisionId = input.revisionId ?? "plan-rev-2";
  return {
    id: `interaction-${input.gate}`,
    companyId: "company-1",
    issueId: "root",
    kind: "request_confirmation",
    idempotencyKey: input.gate === "plan"
      ? `confirmation:root:plan:${revisionId}`
      : `confirmation:root:start:${revisionId}:g${input.graphRev ?? "1"}`,
    title: input.gate === "plan" ? "Approve plan" : "Authorize start",
    status: input.status,
    continuationPolicy: "wake_assignee",
    resolverPolicy: "board_only",
    requestedResolverPolicy: "board_only",
    effectiveResolverPolicy: "board_only",
    payload: { version: 1, prompt: input.gate === "plan" ? "Approve this plan?" : "Start implementation?" },
    result: input.status === "pending" ? null : {
      version: 1,
      outcome: input.status,
      reason: input.reason ?? null,
    },
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T01:00:00Z",
  };
}

describe("SDLC workflow evidence", () => {
  it("fails closed with the malformed JSONL line number", () => {
    expect(parseSdlcEvidenceRegistry('{"id":"ok"}\nnot-json\n')).toEqual({
      records: [],
      error: "Evidence line 1 has an invalid lifecycle envelope.",
    });
    expect(parseSdlcEvidenceRegistry('{"id":"ok","type":"x","companyId":"c","issueId":"i"}\nnot-json\n')).toEqual({
      records: [],
      error: "Evidence line 2 is not valid JSON.",
    });
  });

  it("uses the same acceptance-row identity and planned metadata as the lifecycle contract", () => {
    const description = "Planned owner: Web Platform Engineer.\nEstimate: 3 person-days; due 2026-09-15.\n\n## Acceptance Criteria\n- First row\n- Second row";
    expect(extractSdlcAcceptanceCriteria(description)).toEqual([
      { rowId: "ac-1", text: "First row" },
      { rowId: "ac-2", text: "Second row" },
    ]);
    expect(extractSdlcPlanningMetadata(description)).toEqual({
      owner: "Web Platform Engineer",
      estimate: "3 person-days",
      dueDate: "2026-09-15",
    });
  });

  it("names a rejected Gate 2 reason and every missing completion row", () => {
    const root = issue({});
    const child = issue({
      id: "child-1",
      parentId: "root",
      identifier: "STA-2",
      title: "Board workflow",
      status: "in_review",
      description: "Estimate: 3 person-days; due 2026-09-15.\n\n## Acceptance Criteria\n- Board sees missing evidence\n- Token gates pass",
      blockedBy: [],
    });
    const records = [
      record("classification", { class: "C3" }),
      record("dor_validated", { revisionId: "plan-rev-2", result: "pass", missingRows: [] }),
      record("gate_decision", { gate: "gate1", revisionId: "plan-rev-2", verdict: "accepted" }),
      record("provisioning_write", { op: "provision_task", taskKey: "G", childIssueId: "child-1", plannedAssigneeAgentId: "agent-web", graphRev: "1" }),
      record("provisioning_complete", { revisionId: "plan-rev-2", graphRev: "1", children: ["child-1"] }),
      record("gate_decision", { idSuffix: "gate2", gate: "gate2", revisionId: "plan-rev-2", graphRev: "1", verdict: "rejected", reason: "Reduce the rollout scope." }),
    ];
    const summary = deriveSdlcWorkflowSummary({
      rootIssue: root,
      currentIssue: child,
      treeIssues: [child],
      records,
      interactions: [
        gateInteraction({ gate: "plan", status: "accepted" }),
        gateInteraction({ gate: "start", status: "rejected", reason: "Reduce the rollout scope." }),
      ],
      agentNameById: new Map([["agent-web", "Web Platform Engineer"]]),
    });

    expect(summary.decision.label).toContain("Gate 2");
    expect(summary.decision.detail).toBe("Reduce the rollout scope.");
    expect(summary.gate2.state).toBe("rejected");
    expect(summary.completionRows.filter((row) => row.state === "pending").map((row) => row.id)).toEqual([
      "ac-1",
      "ac-2",
      "review:pr",
      "review:checks",
      "review:independent",
    ]);
    expect(summary.tasks[0]).toMatchObject({
      identifier: "STA-2",
      plannedOwner: "Web Platform Engineer",
      estimate: "3 person-days",
      dueDate: "2026-09-15",
    });
  });

  it("surfaces stale approvals and provider drift with direct evidence links", () => {
    const root = issue({});
    const records = [
      record("classification", { class: "C2" }),
      record("dor_validated", { revisionId: "plan-rev-2", result: "pass", missingRows: [] }),
      record("provisioning_complete", { revisionId: "plan-rev-2", graphRev: "2", children: [] }),
      record("gate_decision", { gate: "gate1", revisionId: "plan-rev-1", verdict: "accepted" }),
      record("gate_decision", { idSuffix: "gate2", gate: "gate2", revisionId: "plan-rev-1", graphRev: "1", verdict: "accepted" }),
      record("provider_readback", { idSuffix: "clickup-1", provider: "clickup", result: "pass", evidenceUrl: "https://example.test/readback", createdAt: "2026-08-28T01:00:00Z" }),
      record("reconciliation_summary", { idSuffix: "clickup-2", provider: "clickup", driftCounts: { MISSING: 2 }, createdAt: "2026-08-28T02:00:00Z" }),
    ];
    const summary = deriveSdlcWorkflowSummary({
      rootIssue: root,
      currentIssue: root,
      treeIssues: [],
      records,
      interactions: [
        gateInteraction({ gate: "plan", status: "accepted", revisionId: "plan-rev-1" }),
        gateInteraction({ gate: "start", status: "accepted", revisionId: "plan-rev-1", graphRev: "1" }),
      ],
    });

    expect(summary.gate1.state).toBe("stale");
    expect(summary.gate2.state).toBe("stale");
    expect(summary.providers).toEqual([{ provider: "clickup", state: "fail", detail: "2 unresolved drift items." }]);
    expect(summary.evidenceLinks).toEqual([
      expect.objectContaining({ href: "https://example.test/readback", label: "clickup provider readback" }),
    ]);
  });
});
