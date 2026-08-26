import { createHash } from "node:crypto";
import type {
  CompletedIssueTelemetryReport,
  CompletedIssueTelemetryRow,
  CompletedIssueTokenDimensions,
  EvaluateAuthoritativeSessionReuse,
  SessionReuseCriterionStatus,
  SessionReuseEvaluationReport,
  TokenTelemetryDimensionCount,
} from "@paperclipai/shared";

export interface CompletedIssueSource {
  id: string;
  companyId: string;
  identifier: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  workMode: string;
  priority: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface CompletedIssueRunSource {
  id: string;
  companyId: string;
  agentId: string;
  responsibleUserId: string | null;
  status: string;
  sessionIdBefore: string | null;
  contextSnapshot: Record<string, unknown> | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
}

export interface CompletedIssueCostSource {
  id: string;
  companyId: string;
  issueId: string | null;
  heartbeatRunId: string | null;
  billingType: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface CompletedIssueWakeSource {
  id: string;
  companyId: string;
  runId: string | null;
  status: string;
  coalescedCount: number;
  payload: Record<string, unknown> | null;
}

export interface CompletedIssueActivitySource {
  companyId: string;
  entityId: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

interface SessionEvidence {
  reused: boolean | null;
  eligibleRepeat: boolean;
  resetReasons: string[];
  configFingerprint: string | null;
}

const BOUNDARY_VERSION = "session-reuse-boundary-v1" as const;
const MATCHED_SAMPLE_MINIMUM = 22 as const;
const THRESHOLDS = {
  processedTokenReductionPercent: 5 as const,
  eligibleRepeatReusePercent: 70 as const,
  firstPassAcceptanceDeltaPercentagePoints: -5 as const,
  reopenRateRegressionPercentagePoints: 5 as const,
  createdToDoneRegressionPercent: 5 as const,
  stretchProcessedTokenReductionPercent: 25 as const,
  maximumBoundaryLeakageCount: 0 as const,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function emptyDimensions(): CompletedIssueTokenDimensions {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    processedTokens: 0,
    costCents: 0,
  };
}

function addDimensions(target: CompletedIssueTokenDimensions, source: CompletedIssueCostSource) {
  const uncachedInputTokens = nonNegativeInteger(source.inputTokens);
  const cachedInputTokens = nonNegativeInteger(source.cachedInputTokens);
  const outputTokens = nonNegativeInteger(source.outputTokens);
  target.uncachedInputTokens += uncachedInputTokens;
  target.cachedInputTokens += cachedInputTokens;
  target.outputTokens += outputTokens;
  target.processedTokens += uncachedInputTokens + cachedInputTokens + outputTokens;
  target.costCents += nonNegativeInteger(source.costCents);
}

function billingBucket(billingType: string): "metered" | "subscription" | "other" | "unknown" {
  if (billingType === "metered_api") return "metered";
  if (billingType === "subscription_included" || billingType === "subscription_overage") {
    return "subscription";
  }
  if (billingType === "credits" || billingType === "fixed") return "other";
  return "unknown";
}

function issueIdFromContext(contextSnapshot: Record<string, unknown> | null): string | null {
  const context = asRecord(contextSnapshot);
  return nonEmptyString(context.issueId) ?? nonEmptyString(context.taskId);
}

function sessionEvidence(run: CompletedIssueRunSource): SessionEvidence {
  const usage = asRecord(run.usageJson);
  const result = asRecord(run.resultJson);
  const context = asRecord(run.contextSnapshot);
  const usageFreshness = asRecord(usage.configFreshness);
  const resultFreshness = asRecord(result.configFreshness);
  const freshness = Object.keys(usageFreshness).length > 0 ? usageFreshness : resultFreshness;
  const session = asRecord(freshness.session);
  const resetReasons = Array.isArray(session.resetReasons)
    ? session.resetReasons.map(nonEmptyString).filter((value): value is string => value !== null)
    : [];
  const rotationReason = nonEmptyString(usage.sessionRotationReason);
  if (rotationReason) resetReasons.push(rotationReason);
  const forcedFresh = context.forceFreshSession === true;
  if (forcedFresh) resetReasons.push("forced_fresh_requested");
  const freshSession = usage.freshSession === true || result.freshSession === true;
  if (freshSession && resetReasons.length === 0) resetReasons.push("no_prior_session");
  const reset = session.reset === true;
  if (reset && resetReasons.length === 0) resetReasons.push("unspecified_session_reset");
  const reused = typeof usage.taskSessionReused === "boolean"
    ? usage.taskSessionReused
    : typeof session.taskSessionReused === "boolean"
      ? session.taskSessionReused
      : null;
  const taskSessionAvailable = typeof session.taskSessionAvailable === "boolean"
    ? session.taskSessionAvailable
    : false;
  const repeatSessionAvailable = taskSessionAvailable || run.sessionIdBefore !== null || reused === true;
  return {
    reused,
    eligibleRepeat: reused !== null
      && repeatSessionAvailable
      && !freshSession
      && !forcedFresh
      && !reset
      && !rotationReason
      && resetReasons.length === 0,
    resetReasons: [...new Set(resetReasons)],
    configFingerprint: nonEmptyString(session.nextFingerprint),
  };
}

function sortedCounts(values: string[]): TokenTelemetryDimensionCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function percentageChange(next: number | null, baseline: number | null): number | null {
  if (next === null || baseline === null || baseline === 0) return null;
  return Number((((next - baseline) / baseline) * 100).toFixed(2));
}

function percentagePointDelta(next: number | null, baseline: number | null): number | null {
  if (next === null || baseline === null) return null;
  return Number((next - baseline).toFixed(2));
}

function hash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function cohortKey(issue: CompletedIssueSource): string {
  return [
    `project:${issue.projectId ?? "unattributed"}`,
    `assignee:${issue.assigneeAgentId ?? "unassigned"}`,
    `mode:${issue.workMode}`,
    `priority:${issue.priority}`,
  ].join("|");
}

function boundaryTuple(run: CompletedIssueRunSource, issueId: string, evidence: SessionEvidence) {
  return {
    companyId: run.companyId,
    issueId,
    agentId: run.agentId,
    responsibleUserId: run.responsibleUserId ?? "none",
    sessionConfigFingerprint: evidence.configFingerprint ?? "missing",
    sessionIdentityFingerprint: run.sessionIdBefore ? hash(run.sessionIdBefore) : "missing",
  };
}

export function buildCompletedIssueTelemetry(input: {
  companyId: string;
  from: Date;
  toExclusive: Date;
  issues: CompletedIssueSource[];
  runs: CompletedIssueRunSource[];
  costEvents: CompletedIssueCostSource[];
  wakeRequests: CompletedIssueWakeSource[];
  activities: CompletedIssueActivitySource[];
  generatedAt?: Date;
}): CompletedIssueTelemetryReport {
  const selectedIssues = input.issues.filter((issue) =>
    issue.companyId === input.companyId
    && issue.completedAt !== null
    && issue.completedAt >= input.from
    && issue.completedAt < input.toExclusive);
  const selectedIssueIds = new Set(selectedIssues.map((issue) => issue.id));
  const issueRuns = new Map<string, CompletedIssueRunSource[]>();
  const runToIssue = new Map<string, string>();
  const sharedSessionOwners = new Map<string, Set<string>>();
  const sharedSessionPrincipals = new Map<string, Set<string>>();

  for (const run of input.runs) {
    if (run.companyId !== input.companyId) continue;
    const issueId = issueIdFromContext(run.contextSnapshot);
    if (!issueId) continue;
    const evidence = sessionEvidence(run);
    if (evidence.reused && run.sessionIdBefore) {
      const sessionFingerprint = hash(run.sessionIdBefore);
      const owners = sharedSessionOwners.get(sessionFingerprint) ?? new Set<string>();
      owners.add(issueId);
      sharedSessionOwners.set(sessionFingerprint, owners);
      const principals = sharedSessionPrincipals.get(sessionFingerprint) ?? new Set<string>();
      principals.add(run.responsibleUserId ?? "none");
      sharedSessionPrincipals.set(sessionFingerprint, principals);
    }
    if (!selectedIssueIds.has(issueId)) continue;
    runToIssue.set(run.id, issueId);
    const group = issueRuns.get(issueId) ?? [];
    group.push(run);
    issueRuns.set(issueId, group);
  }

  const issueCosts = new Map<string, CompletedIssueCostSource[]>();
  const issueCostViolations = new Map<string, Set<string>>();
  for (const event of input.costEvents) {
    if (event.companyId !== input.companyId) continue;
    const runIssueId = event.heartbeatRunId ? runToIssue.get(event.heartbeatRunId) ?? null : null;
    const directIssueId = event.issueId && selectedIssueIds.has(event.issueId) ? event.issueId : null;
    const issueId = directIssueId ?? runIssueId;
    if (!issueId) continue;
    if (directIssueId && runIssueId && directIssueId !== runIssueId) {
      const violations = issueCostViolations.get(issueId) ?? new Set<string>();
      violations.add("cost_event_issue_run_mismatch");
      issueCostViolations.set(issueId, violations);
    }
    const group = issueCosts.get(issueId) ?? [];
    group.push(event);
    issueCosts.set(issueId, group);
  }

  const issueWakes = new Map<string, CompletedIssueWakeSource[]>();
  const issueWakeViolations = new Map<string, Set<string>>();
  for (const wake of input.wakeRequests) {
    if (wake.companyId !== input.companyId || wake.status === "skipped") continue;
    const payloadIssueId = issueIdFromContext(wake.payload);
    const runIssueId = wake.runId ? runToIssue.get(wake.runId) ?? null : null;
    const issueId = payloadIssueId && selectedIssueIds.has(payloadIssueId) ? payloadIssueId : runIssueId;
    if (!issueId) continue;
    if (payloadIssueId && runIssueId && payloadIssueId !== runIssueId) {
      const violations = issueWakeViolations.get(issueId) ?? new Set<string>();
      violations.add("wake_request_issue_run_mismatch");
      issueWakeViolations.set(issueId, violations);
    }
    const group = issueWakes.get(issueId) ?? [];
    group.push(wake);
    issueWakes.set(issueId, group);
  }

  const issueActivities = new Map<string, CompletedIssueActivitySource[]>();
  for (const activity of input.activities) {
    if (activity.companyId !== input.companyId || !selectedIssueIds.has(activity.entityId)) continue;
    const group = issueActivities.get(activity.entityId) ?? [];
    group.push(activity);
    issueActivities.set(activity.entityId, group);
  }

  const completedIssues = selectedIssues.map((issue): CompletedIssueTelemetryRow => {
    const runs = issueRuns.get(issue.id) ?? [];
    const costs = issueCosts.get(issue.id) ?? [];
    const wakes = issueWakes.get(issue.id) ?? [];
    const activities = issueActivities.get(issue.id) ?? [];
    const total = emptyDimensions();
    const metered = emptyDimensions();
    const subscription = emptyDimensions();
    const other = emptyDimensions();
    const unknown = emptyDimensions();
    for (const event of costs) {
      addDimensions(total, event);
      addDimensions({ metered, subscription, other, unknown }[billingBucket(event.billingType)], event);
    }

    const reopenCount = activities.filter((activity) => {
      const details = asRecord(activity.details);
      return activity.action === "issue.reopened" || details.reopened === true;
    }).length;
    const evidenceByRun = runs.map((run) => ({ run, evidence: sessionEvidence(run) }));
    const eligible = evidenceByRun.filter(({ evidence }) => evidence.eligibleRepeat);
    const reused = eligible.filter(({ evidence }) => evidence.reused === true);
    const resetReasons = evidenceByRun.flatMap(({ evidence }) => evidence.resetReasons);
    const configFingerprints = [...new Set(evidenceByRun
      .map(({ evidence }) => evidence.configFingerprint)
      .filter((value): value is string => value !== null))].sort();
    const violations = new Set([
      ...(issueCostViolations.get(issue.id) ?? []),
      ...(issueWakeViolations.get(issue.id) ?? []),
    ]);
    const boundaryTuples = evidenceByRun.map(({ run, evidence }) => {
      const context = asRecord(run.contextSnapshot);
      const contextCompanyId = nonEmptyString(context.companyId);
      const contextResponsibleUserId = nonEmptyString(context.responsibleUserId);
      const contextAgentId = nonEmptyString(context.agentId);
      if (run.companyId !== issue.companyId) violations.add("run_company_mismatch");
      if (issueIdFromContext(run.contextSnapshot) !== issue.id) violations.add("run_issue_mismatch");
      if (contextCompanyId && contextCompanyId !== issue.companyId) violations.add("run_context_company_mismatch");
      if (contextResponsibleUserId && contextResponsibleUserId !== run.responsibleUserId) {
        violations.add("run_context_security_principal_mismatch");
      }
      if (contextAgentId && contextAgentId !== run.agentId) violations.add("run_context_agent_mismatch");
      if (evidence.reused) {
        if (!run.sessionIdBefore) violations.add("reused_session_identity_missing");
        if (!evidence.configFingerprint) violations.add("reused_session_security_fingerprint_missing");
        if (run.sessionIdBefore) {
          const sessionFingerprint = hash(run.sessionIdBefore);
          if ((sharedSessionOwners.get(sessionFingerprint)?.size ?? 0) > 1) {
            violations.add("session_reused_across_issues");
          }
          if ((sharedSessionPrincipals.get(sessionFingerprint)?.size ?? 0) > 1) {
            violations.add("session_reused_across_security_principals");
          }
        }
      }
      return boundaryTuple(run, issue.id, evidence);
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const principals = new Set(runs.map((run) => run.responsibleUserId ?? "none"));
    const expectedActionableWakeCount = wakes.reduce((sum, wake) => {
      const coalesced = nonNegativeInteger(wake.coalescedCount);
      return sum + (wake.status === "coalesced" ? Math.max(1, coalesced) : 1 + coalesced);
    }, 0);

    return {
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? issue.id,
      companyId: issue.companyId,
      projectId: issue.projectId,
      assigneeAgentId: issue.assigneeAgentId,
      workMode: issue.workMode,
      priority: issue.priority,
      cohortKey: cohortKey(issue),
      createdAt: issue.createdAt.toISOString(),
      completedAt: issue.completedAt!.toISOString(),
      accounting: {
        total,
        metered,
        subscription,
        other,
        unknown,
        costEventCount: costs.length,
        unclassifiedCostEventCount: costs.filter((event) => billingBucket(event.billingType) === "unknown").length,
        evidenceComplete: costs.length > 0
          && costs.every((event) => billingBucket(event.billingType) !== "unknown"),
      },
      lifecycle: {
        firstPassAccepted: reopenCount === 0,
        reopened: reopenCount > 0,
        reopenCount,
        reopenRatePercent: reopenCount > 0 ? 100 : 0,
        createdToDoneMs: Math.max(0, issue.completedAt!.getTime() - issue.createdAt.getTime()),
      },
      wakes: {
        expectedActionableWakeCount,
        observedActionableWakeCount: new Set(runs.map((run) => run.id)).size,
      },
      session: {
        eligibleRepeatRunCount: eligible.length,
        reusedRunCount: reused.length,
        reuseRatePercent: percent(reused.length, eligible.length),
        reused: reused.length > 0,
        resetReasons: sortedCounts(resetReasons),
      },
      boundary: {
        version: BOUNDARY_VERSION,
        fingerprint: hash({ version: BOUNDARY_VERSION, issueId: issue.id, boundaryTuples }),
        evidenceComplete: violations.size === 0,
        sessionConfigFingerprints: configFingerprints,
        principalCount: principals.size,
        violations: [...violations].sort(),
      },
    };
  }).sort((left, right) =>
    left.completedAt.localeCompare(right.completedAt)
    || left.issueIdentifier.localeCompare(right.issueIdentifier));

  return {
    companyId: input.companyId,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    window: { from: input.from.toISOString(), toExclusive: input.toExclusive.toISOString() },
    completedIssues,
  };
}

function criterion(
  actual: number | null,
  threshold: number,
  comparison: ">=" | "<=" | "=",
  sufficient: boolean,
): { status: SessionReuseCriterionStatus; actual: number | null; threshold: number; comparison: string } {
  if (!sufficient || actual === null) return { status: "insufficient", actual, threshold, comparison };
  const passed = comparison === ">=" ? actual >= threshold : comparison === "<=" ? actual <= threshold : actual === threshold;
  return { status: passed ? "pass" : "fail", actual, threshold, comparison };
}

export function evaluateAuthoritativeSessionReuse(input: {
  companyId: string;
  config: EvaluateAuthoritativeSessionReuse;
  telemetry: CompletedIssueTelemetryReport;
}): SessionReuseEvaluationReport {
  const requestedIssueIds = new Set([
    ...input.config.pilotIssueIds,
    ...input.config.controlIssueIds,
  ]);
  const provenanceViolations = new Map<string, Set<string>>();
  const addProvenanceViolation = (issueId: string, reason: string) => {
    const reasons = provenanceViolations.get(issueId) ?? new Set<string>();
    reasons.add(reason);
    provenanceViolations.set(issueId, reasons);
  };
  if (input.telemetry.companyId !== input.companyId) {
    addProvenanceViolation("telemetry_report", "telemetry_company_mismatch");
  }
  for (const row of input.telemetry.completedIssues) {
    if (requestedIssueIds.has(row.issueId) && row.companyId !== input.companyId) {
      addProvenanceViolation(row.issueId, "telemetry_row_company_mismatch");
    }
  }
  const byId = new Map(input.telemetry.completedIssues.map((row) => [row.issueId, row]));
  const requestedPilotIds = [...input.config.pilotIssueIds];
  const requestedControlIds = [...input.config.controlIssueIds];
  const pilot = requestedPilotIds.flatMap((id) => byId.get(id) ?? []);
  const control = requestedControlIds.flatMap((id) => byId.get(id) ?? []);
  const missingPilotIssueIds = requestedPilotIds.filter((id) => !byId.has(id));
  const missingControlIssueIds = requestedControlIds.filter((id) => !byId.has(id));
  const controlsByCohort = new Map<string, CompletedIssueTelemetryRow[]>();
  for (const row of control) {
    const rows = controlsByCohort.get(row.cohortKey) ?? [];
    rows.push(row);
    controlsByCohort.set(row.cohortKey, rows);
  }
  for (const rows of controlsByCohort.values()) {
    rows.sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.issueId.localeCompare(right.issueId));
  }
  const matchedPilot: CompletedIssueTelemetryRow[] = [];
  const matchedControl: CompletedIssueTelemetryRow[] = [];
  const unmatchedPilotIssueIds: string[] = [];
  for (const row of pilot) {
    const candidates = controlsByCohort.get(row.cohortKey);
    const match = candidates?.shift();
    if (!match) {
      unmatchedPilotIssueIds.push(row.issueId);
      continue;
    }
    matchedPilot.push(row);
    matchedControl.push(match);
  }
  const unmatchedControlIssueIds = [...controlsByCohort.values()].flat().map((row) => row.issueId).sort();
  const exactMatch = missingPilotIssueIds.length === 0
    && missingControlIssueIds.length === 0
    && unmatchedPilotIssueIds.length === 0
    && unmatchedControlIssueIds.length === 0
    && requestedPilotIds.length === requestedControlIds.length;
  const minimumSampleMet = matchedPilot.length >= MATCHED_SAMPLE_MINIMUM
    && matchedControl.length >= MATCHED_SAMPLE_MINIMUM;
  const accountingComplete = [...matchedPilot, ...matchedControl].every((row) => row.accounting.evidenceComplete);
  for (const row of [...pilot, ...control]) {
    if (!row.boundary.evidenceComplete || row.boundary.violations.length > 0) {
      const reasons = row.boundary.violations.length > 0
        ? row.boundary.violations
        : ["boundary_evidence_incomplete"];
      for (const reason of reasons) addProvenanceViolation(row.issueId, reason);
    }
  }
  const boundaryViolations = [...provenanceViolations.entries()]
    .map(([issueId, reasons]) => ({ issueId, reasons: [...reasons].sort() }))
    .sort((left, right) => left.issueId.localeCompare(right.issueId));
  const sufficient = minimumSampleMet && exactMatch && accountingComplete && boundaryViolations.length === 0;

  const pilotProcessed = average(matchedPilot.map((row) => row.accounting.total.processedTokens));
  const controlProcessed = average(matchedControl.map((row) => row.accounting.total.processedTokens));
  const processedReduction = percentageChange(pilotProcessed, controlProcessed);
  const processedTokenReductionPercent = processedReduction === null ? null : Number((-processedReduction).toFixed(2));
  const eligibleRepeatRunCount = matchedPilot.reduce((sum, row) => sum + row.session.eligibleRepeatRunCount, 0);
  const reusedRepeatRunCount = matchedPilot.reduce((sum, row) => sum + row.session.reusedRunCount, 0);
  const eligibleRepeatReusePercent = percent(reusedRepeatRunCount, eligibleRepeatRunCount);
  const pilotFirstPass = percent(matchedPilot.filter((row) => row.lifecycle.firstPassAccepted).length, matchedPilot.length);
  const controlFirstPass = percent(matchedControl.filter((row) => row.lifecycle.firstPassAccepted).length, matchedControl.length);
  const firstPassDelta = percentagePointDelta(pilotFirstPass, controlFirstPass);
  const pilotReopen = percent(matchedPilot.filter((row) => row.lifecycle.reopened).length, matchedPilot.length);
  const controlReopen = percent(matchedControl.filter((row) => row.lifecycle.reopened).length, matchedControl.length);
  const reopenDelta = percentagePointDelta(pilotReopen, controlReopen);
  const pilotDuration = average(matchedPilot.map((row) => row.lifecycle.createdToDoneMs));
  const controlDuration = average(matchedControl.map((row) => row.lifecycle.createdToDoneMs));
  const durationRegression = percentageChange(pilotDuration, controlDuration);

  const criteria = {
    minimumPilotCompletedIssues: criterion(
      pilot.length,
      MATCHED_SAMPLE_MINIMUM,
      ">=",
      exactMatch && pilot.length >= MATCHED_SAMPLE_MINIMUM,
    ),
    minimumMatchedControlCompletedIssues: criterion(
      matchedControl.length,
      MATCHED_SAMPLE_MINIMUM,
      ">=",
      exactMatch && matchedControl.length >= MATCHED_SAMPLE_MINIMUM,
    ),
    processedTokenReduction: criterion(processedTokenReductionPercent, THRESHOLDS.processedTokenReductionPercent, ">=", sufficient),
    eligibleRepeatReuse: criterion(eligibleRepeatReusePercent, THRESHOLDS.eligibleRepeatReusePercent, ">=", sufficient),
    firstPassAcceptance: criterion(firstPassDelta, THRESHOLDS.firstPassAcceptanceDeltaPercentagePoints, ">=", sufficient),
    reopenRateRegression: criterion(reopenDelta, THRESHOLDS.reopenRateRegressionPercentagePoints, "<=", sufficient),
    createdToDoneRegression: criterion(durationRegression, THRESHOLDS.createdToDoneRegressionPercent, "<=", sufficient),
    boundaryLeakage: criterion(boundaryViolations.length, THRESHOLDS.maximumBoundaryLeakageCount, "=", minimumSampleMet && exactMatch),
  };
  const evidenceGaps: string[] = [];
  if (!minimumSampleMet) evidenceGaps.push("minimum_22_pilot_and_22_matched_controls_not_met");
  if (!exactMatch) evidenceGaps.push("pilot_control_evidence_is_missing_or_unmatched");
  if (!accountingComplete) evidenceGaps.push("completed_issue_accounting_evidence_missing");
  if (eligibleRepeatRunCount === 0) evidenceGaps.push("eligible_repeat_session_evidence_missing");
  const statuses = Object.values(criteria).map((row) => row.status);
  const verdict = boundaryViolations.length > 0
    ? "FAIL"
    : statuses.includes("insufficient") || evidenceGaps.length > 0
      ? "CONDITIONAL"
      : statuses.includes("fail")
        ? "FAIL"
        : "PASS";
  const decision = verdict === "PASS"
    ? {
        action: "eligible_for_authorized_expansion_keep_disabled_now" as const,
        rollbackRequired: false as const,
        reason: "The development evidence meets the stage gate; session reuse remains disabled until a separately authorized expansion.",
      }
    : {
        action: "keep_disabled" as const,
        rollbackRequired: false as const,
        reason: verdict === "FAIL"
          ? "The authoritative stage gate failed; keep session reuse disabled. No rollback is required because this evaluation is read-only."
          : "Evidence is insufficient for expansion; keep session reuse disabled. No rollback is required because this evaluation is read-only.",
      };

  return {
    evaluator: {
      name: "authoritative_completed_issue_session_reuse_v1",
      diagnosticOnly: false,
      realizedProductionSavings: false,
    },
    evaluatedConfiguration: {
      companyId: input.companyId,
      window: {
        from: new Date(input.config.from).toISOString(),
        toExclusive: new Date(input.config.toExclusive).toISOString(),
      },
      pilotIssueIds: requestedPilotIds,
      controlIssueIds: requestedControlIds,
      matchingDimensions: ["projectId", "assigneeAgentId", "workMode", "priority"],
      minimumPilotCompletedIssues: MATCHED_SAMPLE_MINIMUM,
      minimumMatchedControlCompletedIssues: MATCHED_SAMPLE_MINIMUM,
      thresholds: THRESHOLDS,
    },
    sample: {
      requestedPilotCount: requestedPilotIds.length,
      requestedControlCount: requestedControlIds.length,
      pilotCompletedCount: pilot.length,
      controlCompletedCount: control.length,
      matchedPairCount: matchedPilot.length,
      unmatchedPilotIssueIds: unmatchedPilotIssueIds.sort(),
      unmatchedControlIssueIds,
      missingPilotIssueIds,
      missingControlIssueIds,
    },
    metrics: {
      pilotProcessedTokensPerIssue: pilotProcessed,
      controlProcessedTokensPerIssue: controlProcessed,
      processedTokenReductionPercent,
      stretchProcessedTokenReductionMet: processedTokenReductionPercent !== null
        && processedTokenReductionPercent >= THRESHOLDS.stretchProcessedTokenReductionPercent,
      eligibleRepeatRunCount,
      reusedRepeatRunCount,
      eligibleRepeatReusePercent,
      pilotFirstPassAcceptancePercent: pilotFirstPass,
      controlFirstPassAcceptancePercent: controlFirstPass,
      firstPassAcceptanceDeltaPercentagePoints: firstPassDelta,
      pilotReopenRatePercent: pilotReopen,
      controlReopenRatePercent: controlReopen,
      reopenRateDeltaPercentagePoints: reopenDelta,
      pilotCreatedToDoneMsPerIssue: pilotDuration,
      controlCreatedToDoneMsPerIssue: controlDuration,
      createdToDoneRegressionPercent: durationRegression,
      boundaryLeakageCount: boundaryViolations.length,
    },
    criteria,
    evidenceGaps,
    boundaryViolations,
    verdict,
    decision,
    pilotIssues: matchedPilot,
    matchedControlIssues: matchedControl,
  };
}
