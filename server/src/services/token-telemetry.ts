import type {
  BillingType,
  TokenTelemetryBaselineReport,
  TokenTelemetryBillingCategory,
  TokenTelemetryCompletedIssueRollup,
  TokenTelemetryDailyRollup,
  TokenTelemetryDimensionCount,
  TokenTelemetryMetrics,
  TokenTelemetryModelSource,
  TokenTelemetryPercentiles,
} from "@paperclipai/shared";

const MINIMUM_BASELINE_DAYS = 14;
const MATCHED_SAMPLE_MINIMUM = 14;
const MATCHED_COHORT_MINIMUM = 2;

const NON_EXACT_MODEL_LABELS = new Set([
  "",
  "auto",
  "default",
  "model",
  "n/a",
  "none",
  "null",
  "unknown",
  "unspecified",
]);
const EXACT_MODEL_SOURCES = new Set<TokenTelemetryModelSource>([
  "cost_event",
  "run_usage",
  "run_result",
  "run_context",
]);

export interface TokenTelemetryModelCandidate {
  value: unknown;
  source: TokenTelemetryModelSource;
}

export interface TokenTelemetryFact {
  eventId: string;
  occurredAt: Date;
  heartbeatRunId: string | null;
  runStartedAt: Date | null;
  runFinishedAt: Date | null;
  runStatus: string | null;
  triggerDetail: string | null;
  invocationSource: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown> | null;
  agentId: string;
  agentName: string | null;
  agentConfig: Record<string, unknown> | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  issueCompletedAt: Date | null;
  issuePriority: string | null;
  issueWorkMode: string | null;
  issueAssigneeAgentId: string | null;
  issueAssigneeAgentName: string | null;
  projectId: string | null;
  projectName: string | null;
  model: string;
  billingType: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface ResolvedFact extends TokenTelemetryFact {
  exactModel: boolean;
  resolvedModel: string;
  modelSource: TokenTelemetryModelSource;
  wakeReason: string;
  taskSessionReused: boolean | null;
  resetCause: string | null;
  normalizedBillingType: BillingType;
  billingCategory: TokenTelemetryBillingCategory;
  metrics: TokenTelemetryMetrics;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function roundPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function normalizedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function emptyMetrics(): TokenTelemetryMetrics {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    processedTokens: 0,
    paidCostCents: 0,
    meteredProcessedTokens: 0,
    meteredCostCents: 0,
    subscriptionProcessedTokens: 0,
    subscriptionCostCents: 0,
  };
}

function addMetrics(target: TokenTelemetryMetrics, source: TokenTelemetryMetrics) {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.processedTokens += source.processedTokens;
  target.paidCostCents += source.paidCostCents;
  target.meteredProcessedTokens += source.meteredProcessedTokens;
  target.meteredCostCents += source.meteredCostCents;
  target.subscriptionProcessedTokens += source.subscriptionProcessedTokens;
  target.subscriptionCostCents += source.subscriptionCostCents;
}

export function resolveTelemetryModelLabel(candidates: TokenTelemetryModelCandidate[]) {
  let inferred: {
    model: string;
    source: TokenTelemetryModelSource;
    exact: false;
  } | null = null;
  for (const candidate of candidates) {
    const model = nonEmptyString(candidate.value);
    if (!model || NON_EXACT_MODEL_LABELS.has(model.toLowerCase())) continue;
    if (!EXACT_MODEL_SOURCES.has(candidate.source)) {
      inferred ??= { model, source: candidate.source, exact: false };
      continue;
    }
    return { model, source: candidate.source, exact: true };
  }
  return inferred ?? { model: "unknown", source: "unknown" as const, exact: false };
}

function normalizeBillingType(value: string): BillingType {
  switch (value) {
    case "metered_api":
    case "subscription_included":
    case "subscription_overage":
    case "credits":
    case "fixed":
      return value;
    default:
      return "unknown";
  }
}

function billingCategory(value: BillingType): TokenTelemetryBillingCategory {
  if (value === "metered_api") return "metered";
  if (value === "subscription_included" || value === "subscription_overage") return "subscription";
  return "other";
}

function metricsForFact(fact: TokenTelemetryFact, category: TokenTelemetryBillingCategory) {
  const uncachedInputTokens = normalizedCount(fact.inputTokens);
  const cachedInputTokens = normalizedCount(fact.cachedInputTokens);
  const outputTokens = normalizedCount(fact.outputTokens);
  const paidCostCents = normalizedCount(fact.costCents);
  const processedTokens = uncachedInputTokens + cachedInputTokens + outputTokens;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    processedTokens,
    paidCostCents,
    meteredProcessedTokens: category === "metered" ? processedTokens : 0,
    meteredCostCents: category === "metered" ? paidCostCents : 0,
    subscriptionProcessedTokens: category === "subscription" ? processedTokens : 0,
    subscriptionCostCents: category === "subscription" ? paidCostCents : 0,
  };
}

function readResetCause(usageJson: Record<string, unknown>, resultJson: Record<string, unknown>) {
  const usageFreshness = asRecord(usageJson.configFreshness);
  const resultFreshness = asRecord(resultJson.configFreshness);
  const sessionFreshness = asRecord(
    Object.keys(usageFreshness).length > 0
      ? usageFreshness.session
      : resultFreshness.session,
  );
  const resetReasons = Array.isArray(sessionFreshness.resetReasons)
    ? sessionFreshness.resetReasons.map(nonEmptyString).filter((value): value is string => value !== null)
    : [];
  if (resetReasons.length > 0) return resetReasons.join("; ");
  const rotationReason = nonEmptyString(usageJson.sessionRotationReason);
  if (rotationReason) return rotationReason;
  if (sessionFreshness.reset === true) return "unspecified_session_reset";
  if (usageJson.freshSession === true) return "no_prior_session";
  return null;
}

function resolveFact(fact: TokenTelemetryFact): ResolvedFact {
  const usageJson = asRecord(fact.usageJson);
  const resultJson = asRecord(fact.resultJson);
  const contextSnapshot = asRecord(fact.contextSnapshot);
  const telemetryContext = asRecord(contextSnapshot.paperclipTelemetry);
  const agentConfig = asRecord(fact.agentConfig);
  const model = resolveTelemetryModelLabel([
    { value: fact.model, source: "cost_event" },
    { value: usageJson.model, source: "run_usage" },
    { value: resultJson.model, source: "run_result" },
    { value: telemetryContext.configuredModel, source: "run_context" },
    { value: agentConfig.model, source: "agent_config" },
  ]);
  const normalizedBillingType = normalizeBillingType(fact.billingType);
  const category = billingCategory(normalizedBillingType);
  return {
    ...fact,
    exactModel: model.exact,
    resolvedModel: model.model,
    modelSource: model.source,
    wakeReason:
      nonEmptyString(contextSnapshot.wakeReason)
      ?? nonEmptyString(fact.triggerDetail)
      ?? nonEmptyString(fact.invocationSource)
      ?? "unknown",
    taskSessionReused: booleanOrNull(usageJson.taskSessionReused),
    resetCause: readResetCause(usageJson, resultJson),
    normalizedBillingType,
    billingCategory: category,
    metrics: metricsForFact(fact, category),
  };
}

function incrementDimension(map: Map<string, number>, value: string | null) {
  const key = value ?? "unknown";
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedDimensionCounts(map: Map<string, number>): TokenTelemetryDimensionCount[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return Number((lowerValue + (upperValue - lowerValue) * (position - lower)).toFixed(2));
}

function percentiles(values: number[]): TokenTelemetryPercentiles {
  return {
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
  };
}

function cohortKey(fact: ResolvedFact) {
  return [
    `project:${fact.projectId ?? "unattributed"}`,
    `assignee:${fact.issueAssigneeAgentId ?? "unassigned"}`,
    `mode:${fact.issueWorkMode ?? "standard"}`,
    `priority:${fact.issuePriority ?? "unknown"}`,
  ].join("|");
}

function buildDailyRollups(facts: ResolvedFact[]) {
  type MutableDaily = TokenTelemetryDailyRollup & { runIds: Set<string> };
  const groups = new Map<string, MutableDaily>();
  for (const fact of facts) {
    const day = fact.occurredAt.toISOString().slice(0, 10);
    const issueAttribution = fact.issueId ? "issue" as const : "unattributed" as const;
    const key = JSON.stringify([
      day,
      fact.agentId,
      fact.projectId,
      issueAttribution,
      fact.resolvedModel,
      fact.modelSource,
      fact.wakeReason,
      fact.runStatus ?? "unknown",
      fact.taskSessionReused,
      fact.resetCause,
      fact.normalizedBillingType,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        day,
        agentId: fact.agentId,
        agentName: fact.agentName,
        projectId: fact.projectId,
        projectName: fact.projectName,
        issueAttribution,
        model: fact.resolvedModel,
        modelSource: fact.modelSource,
        exactModel: fact.exactModel,
        wakeReason: fact.wakeReason,
        runStatus: fact.runStatus ?? "unknown",
        taskSessionReused: fact.taskSessionReused,
        resetCause: fact.resetCause,
        billingType: fact.normalizedBillingType,
        billingCategory: fact.billingCategory,
        runCount: 0,
        eventCount: 0,
        metrics: emptyMetrics(),
        runIds: new Set<string>(),
      };
      groups.set(key, group);
    }
    group.eventCount += 1;
    if (fact.heartbeatRunId) group.runIds.add(fact.heartbeatRunId);
    addMetrics(group.metrics, fact.metrics);
  }
  return [...groups.values()]
    .map(({ runIds, ...group }) => ({ ...group, runCount: runIds.size }))
    .sort((left, right) =>
      left.day.localeCompare(right.day)
      || left.agentId.localeCompare(right.agentId)
      || (left.projectId ?? "").localeCompare(right.projectId ?? "")
      || left.model.localeCompare(right.model));
}

function buildCompletedIssueRollups(facts: ResolvedFact[], from: Date, toExclusive: Date) {
  interface MutableIssue {
    row: TokenTelemetryCompletedIssueRollup;
    runIds: Set<string>;
    taskSessionEligibleRunIds: Set<string>;
    taskSessionReusedRunIds: Set<string>;
    runDurations: Map<string, number>;
    agents: Map<string, number>;
    models: Map<string, number>;
    modelSources: Map<string, number>;
    wakeReasons: Map<string, number>;
    runStatuses: Map<string, number>;
    resetCauses: Map<string, number>;
    billingTypes: Map<string, number>;
    exactModelPaidSpendCents: number;
  }
  const groups = new Map<string, MutableIssue>();
  for (const fact of facts) {
    if (
      !fact.issueId
      || !fact.issueIdentifier
      || !fact.issueTitle
      || fact.issueStatus !== "done"
      || !fact.issueCompletedAt
      || fact.issueCompletedAt < from
      || fact.issueCompletedAt >= toExclusive
    ) continue;

    let group = groups.get(fact.issueId);
    if (!group) {
      group = {
        row: {
          issueId: fact.issueId,
          issueIdentifier: fact.issueIdentifier,
          title: fact.issueTitle,
          completedAt: fact.issueCompletedAt.toISOString(),
          projectId: fact.projectId,
          projectName: fact.projectName,
          assigneeAgentId: fact.issueAssigneeAgentId,
          assigneeAgentName: fact.issueAssigneeAgentName,
          workMode: fact.issueWorkMode ?? "standard",
          priority: fact.issuePriority ?? "unknown",
          cohortKey: cohortKey(fact),
          runCount: 0,
          runtimeMs: 0,
          taskSessionEligibleRunCount: 0,
          taskSessionReusedRunCount: 0,
          taskSessionReusePercent: null,
          agents: [],
          models: [],
          modelSources: [],
          wakeReasons: [],
          runStatuses: [],
          resetCauses: [],
          billingTypes: [],
          exactModelPaidSpendPercent: 100,
          metrics: emptyMetrics(),
        },
        runIds: new Set<string>(),
        taskSessionEligibleRunIds: new Set<string>(),
        taskSessionReusedRunIds: new Set<string>(),
        runDurations: new Map<string, number>(),
        agents: new Map<string, number>(),
        models: new Map<string, number>(),
        modelSources: new Map<string, number>(),
        wakeReasons: new Map<string, number>(),
        runStatuses: new Map<string, number>(),
        resetCauses: new Map<string, number>(),
        billingTypes: new Map<string, number>(),
        exactModelPaidSpendCents: 0,
      };
      groups.set(fact.issueId, group);
    }
    addMetrics(group.row.metrics, fact.metrics);
    if (fact.exactModel) group.exactModelPaidSpendCents += fact.metrics.paidCostCents;
    incrementDimension(group.agents, `${fact.agentId}:${fact.agentName ?? "unknown"}`);
    incrementDimension(group.models, fact.resolvedModel);
    incrementDimension(group.modelSources, fact.modelSource);
    incrementDimension(group.wakeReasons, fact.wakeReason);
    incrementDimension(group.runStatuses, fact.runStatus);
    incrementDimension(group.resetCauses, fact.resetCause);
    incrementDimension(group.billingTypes, fact.normalizedBillingType);
    if (fact.heartbeatRunId) {
      group.runIds.add(fact.heartbeatRunId);
      if (fact.taskSessionReused !== null) group.taskSessionEligibleRunIds.add(fact.heartbeatRunId);
      if (fact.taskSessionReused === true) group.taskSessionReusedRunIds.add(fact.heartbeatRunId);
      if (fact.runStartedAt) {
        const end = fact.runFinishedAt ?? fact.runStartedAt;
        group.runDurations.set(
          fact.heartbeatRunId,
          Math.max(0, end.getTime() - fact.runStartedAt.getTime()),
        );
      }
    }
  }

  return [...groups.values()]
    .map((group) => {
      const eligible = group.taskSessionEligibleRunIds.size;
      group.row.runCount = group.runIds.size;
      group.row.runtimeMs = [...group.runDurations.values()].reduce((sum, value) => sum + value, 0);
      group.row.taskSessionEligibleRunCount = eligible;
      group.row.taskSessionReusedRunCount = group.taskSessionReusedRunIds.size;
      group.row.taskSessionReusePercent = eligible > 0
        ? roundPercent(group.taskSessionReusedRunIds.size, eligible)
        : null;
      group.row.agents = sortedDimensionCounts(group.agents);
      group.row.models = sortedDimensionCounts(group.models);
      group.row.modelSources = sortedDimensionCounts(group.modelSources);
      group.row.wakeReasons = sortedDimensionCounts(group.wakeReasons);
      group.row.runStatuses = sortedDimensionCounts(group.runStatuses);
      group.row.resetCauses = sortedDimensionCounts(group.resetCauses);
      group.row.billingTypes = sortedDimensionCounts(group.billingTypes);
      group.row.exactModelPaidSpendPercent = roundPercent(
        group.exactModelPaidSpendCents,
        group.row.metrics.paidCostCents,
      );
      return group.row;
    })
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.issueIdentifier.localeCompare(right.issueIdentifier));
}

function buildCohortBaselines(issues: TokenTelemetryCompletedIssueRollup[]) {
  const groups = new Map<string, TokenTelemetryCompletedIssueRollup[]>();
  for (const issue of issues) {
    const group = groups.get(issue.cohortKey) ?? [];
    group.push(issue);
    groups.set(issue.cohortKey, group);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      cohortKey: key,
      projectId: rows[0]?.projectId ?? null,
      assigneeAgentId: rows[0]?.assigneeAgentId ?? null,
      workMode: rows[0]?.workMode ?? "standard",
      priority: rows[0]?.priority ?? "unknown",
      sampleSize: rows.length,
      matched: rows.length >= MATCHED_COHORT_MINIMUM,
      processedTokens: percentiles(rows.map((row) => row.metrics.processedTokens)),
      uncachedInputTokens: percentiles(rows.map((row) => row.metrics.uncachedInputTokens)),
      cachedInputTokens: percentiles(rows.map((row) => row.metrics.cachedInputTokens)),
      outputTokens: percentiles(rows.map((row) => row.metrics.outputTokens)),
      paidCostCents: percentiles(rows.map((row) => row.metrics.paidCostCents)),
      runCount: percentiles(rows.map((row) => row.runCount)),
      runtimeMs: percentiles(rows.map((row) => row.runtimeMs)),
    }))
    .sort((left, right) => right.sampleSize - left.sampleSize || left.cohortKey.localeCompare(right.cohortKey));
}

export function buildTokenTelemetryBaselineReport(input: {
  companyId: string;
  from: Date;
  toExclusive: Date;
  dailyFacts: TokenTelemetryFact[];
  completedIssueFacts: TokenTelemetryFact[];
  generatedAt?: Date;
}): TokenTelemetryBaselineReport {
  const dailyFacts = input.dailyFacts.map(resolveFact);
  const completedIssueFacts = input.completedIssueFacts.map(resolveFact);
  const completedIssueRollups = buildCompletedIssueRollups(
    completedIssueFacts,
    input.from,
    input.toExclusive,
  );
  const cohortBaselines = buildCohortBaselines(completedIssueRollups);
  const matchedCompletedIssueCount = cohortBaselines
    .filter((cohort) => cohort.matched)
    .reduce((sum, cohort) => sum + cohort.sampleSize, 0);

  const paidSpendCents = dailyFacts.reduce((sum, fact) => sum + fact.metrics.paidCostCents, 0);
  const exactModelPaidSpendCents = dailyFacts.reduce(
    (sum, fact) => sum + (fact.exactModel ? fact.metrics.paidCostCents : 0),
    0,
  );
  type RunAttribution = "issue" | "explicit_unattributed" | "unresolved";
  const tokenRuns = new Map<string, RunAttribution>();
  let unlinkedTokenEventCount = 0;
  for (const fact of dailyFacts) {
    if (fact.metrics.processedTokens <= 0) continue;
    if (!fact.heartbeatRunId) {
      unlinkedTokenEventCount += 1;
      continue;
    }
    const previous = tokenRuns.get(fact.heartbeatRunId);
    const current: RunAttribution = fact.issueId !== null
      ? "issue"
      : fact.runStatus !== null
        ? "explicit_unattributed"
        : "unresolved";
    tokenRuns.set(
      fact.heartbeatRunId,
      previous === "issue" || current === "issue"
        ? "issue"
        : previous === "explicit_unattributed" || current === "explicit_unattributed"
          ? "explicit_unattributed"
          : "unresolved",
    );
  }
  const issueAttributedRunCount = [...tokenRuns.values()]
    .filter((attribution) => attribution === "issue").length;
  const explicitUnattributedRunCount = [...tokenRuns.values()]
    .filter((attribution) => attribution === "explicit_unattributed").length;
  const attributionDenominator = tokenRuns.size + unlinkedTokenEventCount;
  const tokenBearingRunsAccountedPercent = attributionDenominator > 0
    ? roundPercent(
        issueAttributedRunCount + explicitUnattributedRunCount,
        attributionDenominator,
      )
    : 100;
  const consecutiveUtcDays = Math.max(
    0,
    Math.ceil((input.toExclusive.getTime() - input.from.getTime()) / (24 * 60 * 60 * 1000)),
  );
  const exactModelPaidSpendPercent = roundPercent(exactModelPaidSpendCents, paidSpendCents);
  const baselineSampleThresholdMet =
    consecutiveUtcDays >= MINIMUM_BASELINE_DAYS
    || matchedCompletedIssueCount >= MATCHED_SAMPLE_MINIMUM;

  return {
    companyId: input.companyId,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    window: {
      from: input.from.toISOString(),
      toExclusive: input.toExclusive.toISOString(),
      consecutiveUtcDays,
      minimumConsecutiveDays: MINIMUM_BASELINE_DAYS,
      matchedSampleMinimum: MATCHED_SAMPLE_MINIMUM,
    },
    coverage: {
      paidSpendCents,
      exactModelPaidSpendCents,
      exactModelPaidSpendPercent,
      tokenBearingRunCount: tokenRuns.size,
      issueAttributedRunCount,
      explicitUnattributedRunCount,
      tokenBearingRunsAccountedPercent,
      unlinkedTokenEventCount,
      matchedCompletedIssueCount,
      exactModelThresholdMet: exactModelPaidSpendPercent >= 95,
      runAttributionThresholdMet: tokenBearingRunsAccountedPercent >= 95,
      baselineSampleThresholdMet,
    },
    dailyRollups: buildDailyRollups(dailyFacts),
    completedIssueRollups,
    cohortBaselines,
  };
}
