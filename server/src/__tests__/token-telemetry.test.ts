import { describe, expect, it } from "vitest";
import {
  buildTokenTelemetryBaselineReport,
  resolveTelemetryModelLabel,
  type TokenTelemetryFact,
} from "../services/token-telemetry.js";

const from = new Date("2026-08-01T00:00:00.000Z");
const toExclusive = new Date("2026-08-15T00:00:00.000Z");

function fact(overrides: Partial<TokenTelemetryFact> = {}): TokenTelemetryFact {
  return {
    eventId: "event-1",
    occurredAt: new Date("2026-08-02T12:00:00.000Z"),
    heartbeatRunId: "run-1",
    runStartedAt: new Date("2026-08-02T11:59:00.000Z"),
    runFinishedAt: new Date("2026-08-02T12:00:00.000Z"),
    runStatus: "succeeded",
    triggerDetail: null,
    invocationSource: "on_demand",
    usageJson: {
      model: "gpt-5.6-sol",
      taskSessionReused: true,
      freshSession: false,
    },
    resultJson: null,
    contextSnapshot: { wakeReason: "issue_commented" },
    agentId: "agent-1",
    agentName: "DevOps",
    agentConfig: { model: "gpt-5.6-sol" },
    issueId: "issue-1",
    issueIdentifier: "STA-1",
    issueTitle: "First matched issue",
    issueStatus: "done",
    issueCompletedAt: new Date("2026-08-03T00:00:00.000Z"),
    issuePriority: "high",
    issueWorkMode: "standard",
    issueAssigneeAgentId: "agent-1",
    issueAssigneeAgentName: "DevOps",
    projectId: "project-1",
    projectName: "Engineering Ops",
    model: "gpt-5.6-sol",
    billingType: "metered_api",
    inputTokens: 40,
    cachedInputTokens: 40,
    outputTokens: 20,
    costCents: 60,
    ...overrides,
  };
}

describe("token telemetry baseline", () => {
  it("uses the first exact model candidate and rejects placeholder labels", () => {
    expect(resolveTelemetryModelLabel([
      { value: "unknown", source: "cost_event" },
      { value: "auto", source: "run_usage" },
      { value: "claude-opus-4-1", source: "agent_config" },
    ])).toEqual({
      model: "claude-opus-4-1",
      source: "agent_config",
      exact: true,
    });
  });

  it("reports 14-day coverage, matched percentiles, attribution buckets, and separated usage", () => {
    const secondIssue = fact({
      eventId: "event-2",
      heartbeatRunId: "run-2",
      issueId: "issue-2",
      issueIdentifier: "STA-2",
      issueTitle: "Second matched issue",
      issueCompletedAt: new Date("2026-08-04T00:00:00.000Z"),
      model: "unknown",
      usageJson: {
        model: "unknown",
        taskSessionReused: false,
        freshSession: true,
        configFreshness: {
          session: {
            reset: true,
            resetReasons: ["effective run configuration changed: model"],
          },
        },
      },
      agentConfig: { model: "gpt-5.6-sol" },
      inputTokens: 100,
      cachedInputTokens: 150,
      outputTokens: 50,
      costCents: 36,
    });
    const unknownPaidEvent = fact({
      eventId: "event-3",
      heartbeatRunId: null,
      runStartedAt: null,
      runFinishedAt: null,
      runStatus: null,
      issueId: null,
      issueIdentifier: null,
      issueTitle: null,
      issueStatus: null,
      issueCompletedAt: null,
      issuePriority: null,
      issueWorkMode: null,
      issueAssigneeAgentId: null,
      issueAssigneeAgentName: null,
      projectId: null,
      projectName: null,
      model: "unknown",
      usageJson: null,
      contextSnapshot: null,
      agentConfig: {},
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 4,
    });
    const unattributedSubscriptionRun = fact({
      eventId: "event-4",
      heartbeatRunId: "run-3",
      issueId: null,
      issueIdentifier: null,
      issueTitle: null,
      issueStatus: null,
      issueCompletedAt: null,
      issuePriority: null,
      issueWorkMode: null,
      issueAssigneeAgentId: null,
      issueAssigneeAgentName: null,
      projectId: null,
      projectName: null,
      billingType: "subscription_included",
      inputTokens: 10,
      cachedInputTokens: 30,
      outputTokens: 10,
      costCents: 0,
    });

    const report = buildTokenTelemetryBaselineReport({
      companyId: "company-1",
      from,
      toExclusive,
      generatedAt: new Date("2026-08-15T01:00:00.000Z"),
      dailyFacts: [fact(), secondIssue, unknownPaidEvent, unattributedSubscriptionRun],
      completedIssueFacts: [fact(), secondIssue],
    });

    expect(report.window.consecutiveUtcDays).toBe(14);
    expect(report.coverage).toMatchObject({
      paidSpendCents: 100,
      exactModelPaidSpendCents: 96,
      exactModelPaidSpendPercent: 96,
      tokenBearingRunCount: 3,
      issueAttributedRunCount: 2,
      explicitUnattributedRunCount: 1,
      tokenBearingRunsAccountedPercent: 100,
      unlinkedTokenEventCount: 0,
      matchedCompletedIssueCount: 2,
      exactModelThresholdMet: true,
      runAttributionThresholdMet: true,
      baselineSampleThresholdMet: true,
    });
    expect(report.dailyRollups.some((row) =>
      row.billingCategory === "subscription"
      && row.metrics.cachedInputTokens === 30
      && row.issueAttribution === "unattributed")).toBe(true);
    expect(report.dailyRollups.some((row) =>
      row.resetCause === "effective run configuration changed: model"
      && row.taskSessionReused === false)).toBe(true);
    expect(report.completedIssueRollups).toHaveLength(2);
    expect(report.cohortBaselines).toHaveLength(1);
    expect(report.cohortBaselines[0]).toMatchObject({
      sampleSize: 2,
      matched: true,
      processedTokens: { p50: 200, p75: 250, p95: 290 },
      cachedInputTokens: { p50: 95, p75: 122.5, p95: 144.5 },
    });
  });
});
