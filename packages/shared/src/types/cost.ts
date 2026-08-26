import type { BillingType, CostStatus } from "../constants.js";

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string;
  agentName: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export type TokenTelemetryModelSource =
  | "cost_event"
  | "run_usage"
  | "run_result"
  | "run_context"
  | "agent_config"
  | "unknown";

export type TokenTelemetryBillingCategory = "metered" | "subscription" | "other";

export interface TokenTelemetryMetrics {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  processedTokens: number;
  paidCostCents: number;
  meteredProcessedTokens: number;
  meteredCostCents: number;
  subscriptionProcessedTokens: number;
  subscriptionCostCents: number;
}

export interface TokenTelemetryDailyRollup {
  day: string;
  agentId: string;
  agentName: string | null;
  projectId: string | null;
  projectName: string | null;
  issueAttribution: "issue" | "unattributed";
  model: string;
  modelSource: TokenTelemetryModelSource;
  exactModel: boolean;
  wakeReason: string;
  runStatus: string;
  taskSessionReused: boolean | null;
  resetCause: string | null;
  billingType: BillingType;
  billingCategory: TokenTelemetryBillingCategory;
  runCount: number;
  eventCount: number;
  metrics: TokenTelemetryMetrics;
}

export interface TokenTelemetryDimensionCount {
  value: string;
  count: number;
}

export interface TokenTelemetryCompletedIssueRollup {
  issueId: string;
  issueIdentifier: string;
  title: string;
  completedAt: string;
  projectId: string | null;
  projectName: string | null;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  workMode: string;
  priority: string;
  cohortKey: string;
  runCount: number;
  runtimeMs: number;
  taskSessionEligibleRunCount: number;
  taskSessionReusedRunCount: number;
  taskSessionReusePercent: number | null;
  agents: TokenTelemetryDimensionCount[];
  models: TokenTelemetryDimensionCount[];
  modelSources: TokenTelemetryDimensionCount[];
  wakeReasons: TokenTelemetryDimensionCount[];
  runStatuses: TokenTelemetryDimensionCount[];
  resetCauses: TokenTelemetryDimensionCount[];
  billingTypes: TokenTelemetryDimensionCount[];
  exactModelPaidSpendPercent: number;
  metrics: TokenTelemetryMetrics;
}

export interface TokenTelemetryPercentiles {
  p50: number;
  p75: number;
  p95: number;
}

export interface TokenTelemetryCohortBaseline {
  cohortKey: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  workMode: string;
  priority: string;
  sampleSize: number;
  matched: boolean;
  processedTokens: TokenTelemetryPercentiles;
  uncachedInputTokens: TokenTelemetryPercentiles;
  cachedInputTokens: TokenTelemetryPercentiles;
  outputTokens: TokenTelemetryPercentiles;
  paidCostCents: TokenTelemetryPercentiles;
  runCount: TokenTelemetryPercentiles;
  runtimeMs: TokenTelemetryPercentiles;
}

export interface TokenTelemetryCoverage {
  paidSpendCents: number;
  exactModelPaidSpendCents: number;
  exactModelPaidSpendPercent: number;
  tokenBearingRunCount: number;
  issueAttributedRunCount: number;
  explicitUnattributedRunCount: number;
  tokenBearingRunsAccountedPercent: number;
  unlinkedTokenEventCount: number;
  matchedCompletedIssueCount: number;
  exactModelThresholdMet: boolean;
  runAttributionThresholdMet: boolean;
  baselineSampleThresholdMet: boolean;
}

export interface TokenTelemetryBaselineReport {
  companyId: string;
  generatedAt: string;
  window: {
    from: string;
    toExclusive: string;
    consecutiveUtcDays: number;
    minimumConsecutiveDays: number;
    matchedSampleMinimum: number;
  };
  coverage: TokenTelemetryCoverage;
  dailyRollups: TokenTelemetryDailyRollup[];
  completedIssueRollups: TokenTelemetryCompletedIssueRollup[];
  cohortBaselines: TokenTelemetryCohortBaseline[];
}

export interface CompletedIssueTokenDimensions {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  processedTokens: number;
  costCents: number;
}

export interface CompletedIssueAccounting {
  total: CompletedIssueTokenDimensions;
  metered: CompletedIssueTokenDimensions;
  subscription: CompletedIssueTokenDimensions;
  other: CompletedIssueTokenDimensions;
  costEventCount: number;
  evidenceComplete: boolean;
}

export interface CompletedIssueTelemetryRow {
  issueId: string;
  issueIdentifier: string;
  companyId: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  workMode: string;
  priority: string;
  cohortKey: string;
  createdAt: string;
  completedAt: string;
  accounting: CompletedIssueAccounting;
  lifecycle: {
    firstPassAccepted: boolean;
    reopened: boolean;
    reopenCount: number;
    reopenRatePercent: number;
    createdToDoneMs: number;
  };
  wakes: {
    expectedActionableWakeCount: number;
    observedActionableWakeCount: number;
  };
  session: {
    eligibleRepeatRunCount: number;
    reusedRunCount: number;
    reuseRatePercent: number | null;
    reused: boolean;
    resetReasons: TokenTelemetryDimensionCount[];
  };
  boundary: {
    version: "session-reuse-boundary-v1";
    fingerprint: string;
    evidenceComplete: boolean;
    sessionConfigFingerprints: string[];
    principalCount: number;
    violations: string[];
  };
}

export interface CompletedIssueTelemetryReport {
  companyId: string;
  generatedAt: string;
  window: { from: string; toExclusive: string };
  completedIssues: CompletedIssueTelemetryRow[];
}

export type SessionReuseEvaluationVerdict = "PASS" | "FAIL" | "CONDITIONAL";
export type SessionReuseCriterionStatus = "pass" | "fail" | "insufficient";

export interface SessionReuseEvaluationReport {
  evaluator: {
    name: "authoritative_completed_issue_session_reuse_v1";
    diagnosticOnly: false;
    realizedProductionSavings: false;
  };
  evaluatedConfiguration: {
    companyId: string;
    window: { from: string; toExclusive: string };
    pilotIssueIds: string[];
    controlIssueIds: string[];
    matchingDimensions: ["projectId", "assigneeAgentId", "workMode", "priority"];
    minimumPilotCompletedIssues: 22;
    minimumMatchedControlCompletedIssues: 22;
    thresholds: {
      processedTokenReductionPercent: 5;
      eligibleRepeatReusePercent: 70;
      firstPassAcceptanceDeltaPercentagePoints: -5;
      reopenRateRegressionPercentagePoints: 5;
      createdToDoneRegressionPercent: 5;
      stretchProcessedTokenReductionPercent: 25;
      maximumBoundaryLeakageCount: 0;
    };
  };
  sample: {
    requestedPilotCount: number;
    requestedControlCount: number;
    pilotCompletedCount: number;
    controlCompletedCount: number;
    matchedPairCount: number;
    unmatchedPilotIssueIds: string[];
    unmatchedControlIssueIds: string[];
    missingPilotIssueIds: string[];
    missingControlIssueIds: string[];
  };
  metrics: {
    pilotProcessedTokensPerIssue: number | null;
    controlProcessedTokensPerIssue: number | null;
    processedTokenReductionPercent: number | null;
    stretchProcessedTokenReductionMet: boolean;
    eligibleRepeatRunCount: number;
    reusedRepeatRunCount: number;
    eligibleRepeatReusePercent: number | null;
    pilotFirstPassAcceptancePercent: number | null;
    controlFirstPassAcceptancePercent: number | null;
    firstPassAcceptanceDeltaPercentagePoints: number | null;
    pilotReopenRatePercent: number | null;
    controlReopenRatePercent: number | null;
    reopenRateDeltaPercentagePoints: number | null;
    pilotCreatedToDoneMsPerIssue: number | null;
    controlCreatedToDoneMsPerIssue: number | null;
    createdToDoneRegressionPercent: number | null;
    boundaryLeakageCount: number;
  };
  criteria: Record<string, {
    status: SessionReuseCriterionStatus;
    actual: number | null;
    threshold: number;
    comparison: string;
  }>;
  evidenceGaps: string[];
  boundaryViolations: Array<{ issueId: string; reasons: string[] }>;
  verdict: SessionReuseEvaluationVerdict;
  decision: {
    action: "keep_disabled" | "eligible_for_authorized_expansion_keep_disabled_now";
    rollbackRequired: false;
    reason: string;
  };
  pilotIssues: CompletedIssueTelemetryRow[];
  matchedControlIssues: CompletedIssueTelemetryRow[];
}
