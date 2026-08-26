import { randomUUID } from "node:crypto";
import type { CompletedIssueTelemetryRow, EvaluateAuthoritativeSessionReuse } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  buildCompletedIssueTelemetry,
  evaluateAuthoritativeSessionReuse,
} from "../services/completed-issue-telemetry.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const from = new Date("2026-08-01T00:00:00.000Z");
const toExclusive = new Date("2026-09-01T00:00:00.000Z");

function evaluationRow(input: {
  issueId?: string;
  cohortKey: string;
  processedTokens: number;
  reusedRunCount?: number;
  eligibleRepeatRunCount?: number;
  firstPassAccepted?: boolean;
  reopened?: boolean;
  createdToDoneMs: number;
  accountingComplete?: boolean;
  boundaryComplete?: boolean;
  boundaryViolations?: string[];
}): CompletedIssueTelemetryRow {
  const issueId = input.issueId ?? randomUUID();
  const tokenDimensions = {
    uncachedInputTokens: input.processedTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    processedTokens: input.processedTokens,
    costCents: 1,
  };
  const eligibleRepeatRunCount = input.eligibleRepeatRunCount ?? 10;
  const reusedRunCount = input.reusedRunCount ?? 7;
  return {
    issueId,
    issueIdentifier: `TLM-${issueId.slice(0, 4)}`,
    companyId,
    projectId: "22222222-2222-4222-8222-222222222222",
    assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    workMode: "standard",
    priority: "high",
    cohortKey: input.cohortKey,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:00.000Z",
    accounting: {
      total: { ...tokenDimensions },
      metered: { ...tokenDimensions },
      subscription: { ...tokenDimensions, uncachedInputTokens: 0, processedTokens: 0, costCents: 0 },
      other: { ...tokenDimensions, uncachedInputTokens: 0, processedTokens: 0, costCents: 0 },
      unknown: { ...tokenDimensions, uncachedInputTokens: 0, processedTokens: 0, costCents: 0 },
      costEventCount: 1,
      unclassifiedCostEventCount: 0,
      evidenceComplete: input.accountingComplete ?? true,
    },
    lifecycle: {
      firstPassAccepted: input.firstPassAccepted ?? true,
      reopened: input.reopened ?? false,
      reopenCount: input.reopened ? 1 : 0,
      reopenRatePercent: input.reopened ? 100 : 0,
      createdToDoneMs: input.createdToDoneMs,
    },
    wakes: { expectedActionableWakeCount: 1, observedActionableWakeCount: 1 },
    session: {
      eligibleRepeatRunCount,
      reusedRunCount,
      reuseRatePercent: eligibleRepeatRunCount > 0 ? reusedRunCount / eligibleRepeatRunCount * 100 : null,
      reused: reusedRunCount > 0,
      resetReasons: [],
    },
    boundary: {
      version: "session-reuse-boundary-v1",
      fingerprint: `boundary-${issueId}`,
      evidenceComplete: input.boundaryComplete ?? true,
      sessionConfigFingerprints: ["security-fingerprint"],
      principalCount: 1,
      violations: input.boundaryViolations ?? [],
    },
  };
}

function evaluationFixture(count = 22) {
  const pilot = Array.from({ length: count }, (_, index) => evaluationRow({
    cohortKey: `matched-${index}`,
    processedTokens: 950,
    firstPassAccepted: index !== 0,
    reopened: index === 0,
    createdToDoneMs: 105_000,
  }));
  const control = Array.from({ length: count }, (_, index) => evaluationRow({
    cohortKey: `matched-${index}`,
    processedTokens: 1_000,
    eligibleRepeatRunCount: 0,
    reusedRunCount: 0,
    createdToDoneMs: 100_000,
  }));
  const config: EvaluateAuthoritativeSessionReuse = {
    from: from.toISOString(),
    toExclusive: toExclusive.toISOString(),
    pilotIssueIds: pilot.map((row) => row.issueId),
    controlIssueIds: control.map((row) => row.issueId),
  };
  return { pilot, control, config };
}

function evaluateFixture(fixture = evaluationFixture()) {
  return evaluateAuthoritativeSessionReuse({
    companyId,
    config: fixture.config,
    telemetry: {
      companyId,
      generatedAt: "2026-09-01T00:00:00.000Z",
      window: { from: from.toISOString(), toExclusive: toExclusive.toISOString() },
      completedIssues: [...fixture.pilot, ...fixture.control],
    },
  });
}

describe("completed issue telemetry", () => {
  it("reports all accounting, lifecycle, wake, session, and boundary fields", () => {
    const issueId = randomUUID();
    const runId = randomUUID();
    const report = buildCompletedIssueTelemetry({
      companyId,
      from,
      toExclusive,
      generatedAt: new Date("2026-09-01T00:00:00.000Z"),
      issues: [{
        id: issueId,
        companyId,
        identifier: "TLM-1",
        projectId: randomUUID(),
        assigneeAgentId: randomUUID(),
        workMode: "standard",
        priority: "high",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        completedAt: new Date("2026-08-02T00:00:10.000Z"),
      }],
      runs: [{
        id: runId,
        companyId,
        agentId: randomUUID(),
        responsibleUserId: "user-1",
        status: "succeeded",
        sessionIdBefore: "private-session-id",
        contextSnapshot: { issueId },
        usageJson: {
          taskSessionReused: true,
          configFreshness: { session: { nextFingerprint: "security-fingerprint", resetReasons: ["model_changed"] } },
        },
        resultJson: null,
      }],
      costEvents: [
        {
          id: randomUUID(), companyId, issueId, heartbeatRunId: runId, billingType: "metered_api",
          inputTokens: 10, cachedInputTokens: 20, outputTokens: 5, costCents: 3,
        },
        {
          id: randomUUID(), companyId, issueId: null, heartbeatRunId: runId, billingType: "subscription_included",
          inputTokens: 30, cachedInputTokens: 40, outputTokens: 10, costCents: 0,
        },
      ],
      wakeRequests: [
        { id: randomUUID(), companyId, runId, status: "queued", coalescedCount: 1, payload: { issueId } },
        { id: randomUUID(), companyId, runId, status: "coalesced", coalescedCount: 1, payload: { issueId } },
      ],
      activities: [{
        companyId,
        entityId: issueId,
        action: "issue.updated",
        details: { reopened: true, reopenedFrom: "done" },
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
    });

    expect(report.completedIssues).toHaveLength(1);
    expect(report.completedIssues[0]).toMatchObject({
      issueId,
      accounting: {
        total: {
          uncachedInputTokens: 40,
          cachedInputTokens: 60,
          outputTokens: 15,
          processedTokens: 115,
          costCents: 3,
        },
        metered: { processedTokens: 35, costCents: 3 },
        subscription: { processedTokens: 80, costCents: 0 },
        unknown: { processedTokens: 0, costCents: 0 },
        costEventCount: 2,
        unclassifiedCostEventCount: 0,
        evidenceComplete: true,
      },
      lifecycle: {
        firstPassAccepted: false,
        reopened: true,
        reopenCount: 1,
        reopenRatePercent: 100,
        createdToDoneMs: 10_000,
      },
      wakes: { expectedActionableWakeCount: 3, observedActionableWakeCount: 1 },
      session: {
        eligibleRepeatRunCount: 0,
        reusedRunCount: 0,
        reuseRatePercent: null,
        reused: false,
        resetReasons: [{ value: "model_changed", count: 1 }],
      },
      boundary: {
        version: "session-reuse-boundary-v1",
        evidenceComplete: true,
        sessionConfigFingerprints: ["security-fingerprint"],
        principalCount: 1,
        violations: [],
      },
    });
    expect(report.completedIssues[0]?.boundary.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain("private-session-id");
  });

  it("marks a reused session observed across issue boundaries as leakage", () => {
    const issueIds = [randomUUID(), randomUUID()];
    const issues = issueIds.map((issueId, index) => ({
      id: issueId,
      companyId,
      identifier: `TLM-${index + 1}`,
      projectId: null,
      assigneeAgentId: null,
      workMode: "standard",
      priority: "high",
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      completedAt: new Date("2026-08-03T00:00:00.000Z"),
    }));
    const runs = issueIds.map((issueId) => ({
      id: randomUUID(),
      companyId,
      agentId: randomUUID(),
      responsibleUserId: "user-1",
      status: "succeeded",
      sessionIdBefore: "same-private-session",
      contextSnapshot: { issueId, companyId },
      usageJson: {
        taskSessionReused: true,
        configFreshness: { session: { nextFingerprint: "security-fingerprint" } },
      },
      resultJson: null,
    }));
    const report = buildCompletedIssueTelemetry({
      companyId,
      from,
      toExclusive,
      issues,
      runs,
      costEvents: [],
      wakeRequests: [],
      activities: [],
    });

    expect(report.completedIssues).toHaveLength(2);
    expect(report.completedIssues.every((row) => !row.boundary.evidenceComplete)).toBe(true);
    expect(report.completedIssues.every((row) =>
      row.boundary.violations.includes("session_reused_across_issues"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("same-private-session");
  });

  it("marks reuse against an issue outside the selected telemetry cohort as leakage", () => {
    const selectedIssueId = randomUUID();
    const excludedIssueId = randomUUID();
    const report = buildCompletedIssueTelemetry({
      companyId,
      from,
      toExclusive,
      issues: [{
        id: selectedIssueId,
        companyId,
        identifier: "TLM-selected",
        projectId: null,
        assigneeAgentId: null,
        workMode: "standard",
        priority: "high",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        completedAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
      runs: [selectedIssueId, excludedIssueId].map((issueId, index) => ({
        id: randomUUID(),
        companyId,
        agentId: randomUUID(),
        responsibleUserId: `user-${index + 1}`,
        status: "succeeded",
        sessionIdBefore: "shared-outside-selected-cohort",
        contextSnapshot: { issueId, companyId },
        usageJson: {
          taskSessionReused: true,
          configFreshness: { session: { nextFingerprint: "security-fingerprint" } },
        },
        resultJson: null,
      })),
      costEvents: [],
      wakeRequests: [],
      activities: [],
    });

    expect(report.completedIssues).toHaveLength(1);
    expect(report.completedIssues[0]?.boundary).toMatchObject({
      evidenceComplete: false,
      violations: [
        "session_reused_across_issues",
        "session_reused_across_security_principals",
      ],
    });
    expect(JSON.stringify(report)).not.toContain("shared-outside-selected-cohort");
  });

  it("keeps unknown billing separate and marks accounting evidence incomplete", () => {
    const issueId = randomUUID();
    const report = buildCompletedIssueTelemetry({
      companyId,
      from,
      toExclusive,
      issues: [{
        id: issueId,
        companyId,
        identifier: "TLM-unknown-billing",
        projectId: null,
        assigneeAgentId: null,
        workMode: "standard",
        priority: "high",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        completedAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
      runs: [],
      costEvents: [
        {
          id: randomUUID(),
          companyId,
          issueId,
          heartbeatRunId: null,
          billingType: "unknown",
          inputTokens: 10,
          cachedInputTokens: 20,
          outputTokens: 5,
          costCents: 3,
        },
        {
          id: randomUUID(),
          companyId,
          issueId,
          heartbeatRunId: null,
          billingType: "credits",
          inputTokens: 2,
          cachedInputTokens: 3,
          outputTokens: 2,
          costCents: 1,
        },
      ],
      wakeRequests: [],
      activities: [],
    });

    expect(report.completedIssues[0]?.accounting).toMatchObject({
      total: { processedTokens: 42, costCents: 4 },
      metered: { processedTokens: 0, costCents: 0 },
      subscription: { processedTokens: 0, costCents: 0 },
      other: { processedTokens: 7, costCents: 1 },
      unknown: { processedTokens: 35, costCents: 3 },
      costEventCount: 2,
      unclassifiedCostEventCount: 1,
      evidenceComplete: false,
    });
  });

  it("excludes initial fresh and reset runs from the eligible repeat population", () => {
    const issueId = randomUUID();
    const run = (overrides: Partial<Parameters<typeof buildCompletedIssueTelemetry>[0]["runs"][number]>) => ({
      id: randomUUID(),
      companyId,
      agentId: randomUUID(),
      responsibleUserId: "user-1",
      status: "succeeded",
      sessionIdBefore: "available-session",
      contextSnapshot: { issueId },
      usageJson: {
        taskSessionReused: false,
        freshSession: false,
        configFreshness: { session: { taskSessionAvailable: true, reset: false } },
      },
      resultJson: null,
      ...overrides,
    });
    const report = buildCompletedIssueTelemetry({
      companyId,
      from,
      toExclusive,
      issues: [{
        id: issueId,
        companyId,
        identifier: "TLM-repeat-population",
        projectId: null,
        assigneeAgentId: null,
        workMode: "standard",
        priority: "high",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        completedAt: new Date("2026-08-03T00:00:00.000Z"),
      }],
      runs: [
        run({
          sessionIdBefore: null,
          usageJson: { taskSessionReused: false, freshSession: true },
        }),
        run({
          contextSnapshot: { issueId, forceFreshSession: true },
        }),
        run({
          usageJson: {
            taskSessionReused: false,
            freshSession: true,
            configFreshness: {
              session: { taskSessionAvailable: true, reset: true, resetReasons: ["model_changed"] },
            },
          },
        }),
        run({
          usageJson: {
            taskSessionReused: false,
            freshSession: true,
            configFreshness: {
              session: { taskSessionAvailable: true, reset: true, resetReasons: ["security_bindings_changed"] },
            },
          },
        }),
        run({
          usageJson: {
            taskSessionReused: true,
            freshSession: false,
            configFreshness: { session: { taskSessionAvailable: true, reset: false } },
          },
        }),
        run({}),
      ],
      costEvents: [],
      wakeRequests: [],
      activities: [],
    });

    expect(report.completedIssues[0]?.session).toMatchObject({
      eligibleRepeatRunCount: 2,
      reusedRunCount: 1,
      reuseRatePercent: 50,
    });
    expect(report.completedIssues[0]?.session.resetReasons).toEqual([
      { value: "forced_fresh_requested", count: 1 },
      { value: "model_changed", count: 1 },
      { value: "no_prior_session", count: 1 },
      { value: "security_bindings_changed", count: 1 },
    ]);
  });
});

describe("authoritative session reuse evaluation", () => {
  it("passes the exact minimums and stage-gate boundaries while keeping 25% as stretch only", () => {
    const result = evaluateFixture();
    expect(result.verdict).toBe("PASS");
    expect(result.sample.matchedPairCount).toBe(22);
    expect(result.metrics).toMatchObject({
      processedTokenReductionPercent: 5,
      eligibleRepeatReusePercent: 70,
      stretchProcessedTokenReductionMet: false,
      reopenRateDeltaPercentagePoints: 4.55,
      createdToDoneRegressionPercent: 5,
      boundaryLeakageCount: 0,
    });
    expect(result.criteria.firstPassAcceptance.status).toBe("pass");
    expect(result.decision).toMatchObject({
      action: "eligible_for_authorized_expansion_keep_disabled_now",
      rollbackRequired: false,
    });
    expect(result.evaluator.realizedProductionSavings).toBe(false);
  });

  it("accepts exact negative and positive five percentage-point outcome boundaries", () => {
    const fixture = evaluationFixture(40);
    fixture.pilot[0]!.lifecycle.firstPassAccepted = false;
    fixture.pilot[0]!.lifecycle.reopened = true;
    fixture.pilot[1]!.lifecycle.firstPassAccepted = false;
    fixture.pilot[1]!.lifecycle.reopened = true;
    const result = evaluateFixture(fixture);
    expect(result.metrics.firstPassAcceptanceDeltaPercentagePoints).toBe(-5);
    expect(result.metrics.reopenRateDeltaPercentagePoints).toBe(5);
    expect(result.criteria.firstPassAcceptance.status).toBe("pass");
    expect(result.criteria.reopenRateRegression.status).toBe("pass");
    expect(result.verdict).toBe("PASS");
  });

  it("returns CONDITIONAL for fewer than 22/22 or unmatched evidence", () => {
    const small = evaluateFixture(evaluationFixture(21));
    expect(small.verdict).toBe("CONDITIONAL");
    expect(small.evidenceGaps).toContain("minimum_22_pilot_and_22_matched_controls_not_met");

    const unmatchedFixture = evaluationFixture();
    unmatchedFixture.control[0]!.cohortKey = "different";
    const unmatched = evaluateFixture(unmatchedFixture);
    expect(unmatched.verdict).toBe("CONDITIONAL");
    expect(unmatched.sample.unmatchedPilotIssueIds).toContain(unmatchedFixture.pilot[0]!.issueId);
    expect(unmatched.evidenceGaps).toContain("pilot_control_evidence_is_missing_or_unmatched");
  });

  it("fails a sufficient cohort below the five-percent processed-token gate", () => {
    const fixture = evaluationFixture();
    for (const row of fixture.pilot) {
      row.accounting.total.processedTokens = 960;
    }
    const result = evaluateFixture(fixture);
    expect(result.metrics.processedTokenReductionPercent).toBe(4);
    expect(result.criteria.processedTokenReduction.status).toBe("fail");
    expect(result.verdict).toBe("FAIL");
    expect(result.decision.action).toBe("keep_disabled");
  });

  it("returns CONDITIONAL when persisted accounting evidence is missing", () => {
    const fixture = evaluationFixture();
    fixture.pilot[0]!.accounting.evidenceComplete = false;
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("CONDITIONAL");
    expect(result.evidenceGaps).toContain("completed_issue_accounting_evidence_missing");
  });

  it("fails closed when boundary evidence is missing or reports leakage", () => {
    const fixture = evaluationFixture();
    fixture.pilot[0]!.boundary.evidenceComplete = false;
    fixture.pilot[0]!.boundary.violations = ["session_reused_across_issues"];
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("FAIL");
    expect(result.metrics.boundaryLeakageCount).toBe(1);
    expect(result.criteria.boundaryLeakage.status).toBe("fail");
    expect(result.boundaryViolations[0]).toEqual({
      issueId: fixture.pilot[0]!.issueId,
      reasons: ["session_reused_across_issues"],
    });
  });

  it("fails closed when the telemetry report or any selected row belongs to another company", () => {
    const foreignCompanyId = "44444444-4444-4444-8444-444444444444";
    const fixture = evaluationFixture();
    fixture.pilot[0]!.companyId = foreignCompanyId;
    fixture.control[0]!.cohortKey = "unmatched-foreign-row";
    const rowMismatch = evaluateFixture(fixture);
    expect(rowMismatch.verdict).toBe("FAIL");
    expect(rowMismatch.decision.action).toBe("keep_disabled");
    expect(rowMismatch.boundaryViolations).toContainEqual({
      issueId: fixture.pilot[0]!.issueId,
      reasons: ["telemetry_row_company_mismatch"],
    });

    const reportMismatch = evaluateAuthoritativeSessionReuse({
      companyId,
      config: fixture.config,
      telemetry: {
        companyId: foreignCompanyId,
        generatedAt: "2026-09-01T00:00:00.000Z",
        window: { from: from.toISOString(), toExclusive: toExclusive.toISOString() },
        completedIssues: [...fixture.pilot, ...fixture.control],
      },
    });
    expect(reportMismatch.verdict).toBe("FAIL");
    expect(reportMismatch.decision.action).toBe("keep_disabled");
    expect(reportMismatch.boundaryViolations).toContainEqual({
      issueId: "telemetry_report",
      reasons: ["telemetry_company_mismatch"],
    });
  });
});
