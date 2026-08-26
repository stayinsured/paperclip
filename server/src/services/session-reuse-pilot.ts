import type { EvaluateSessionReusePilot } from "@paperclipai/shared";

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const percent = (a: number, b: number) => b ? Number(((a / b) * 100).toFixed(2)) : null;

export function evaluateSessionReusePilot(input: {
  expectedIssueId: string; expectedCompanyId: string; cohort: EvaluateSessionReusePilot;
}) {
  const { observations, controlMedianProcessedTokens } = input.cohort;
  const boundaryViolations = observations.flatMap((row) => {
    if (!row.sessionReused) return [];
    const reasons: string[] = [...row.freshRequiredReasons];
    if (row.issueId !== input.expectedIssueId) reasons.push("issue_changed");
    if (row.companyId !== input.expectedCompanyId) reasons.push("company_changed");
    if (row.forceFreshSession) reasons.push("forced_fresh_requested");
    return reasons.length ? [{ runId: row.runId, reasons: [...new Set(reasons)] }] : [];
  });
  const eligible = observations.filter((row) =>
    row.repeatWake && row.issueId === input.expectedIssueId && row.companyId === input.expectedCompanyId
    && !row.forceFreshSession && row.freshRequiredReasons.length === 0);
  const reused = eligible.filter((row) => row.sessionReused);
  const cohortMedianProcessedTokens = median(eligible.map((row) => row.processedTokens));
  const reuseRatePercent = percent(reused.length, eligible.length);
  const medianProcessedTokenReductionPercent = cohortMedianProcessedTokens === null ? null
    : Number((((controlMedianProcessedTokens - cohortMedianProcessedTokens) / controlMedianProcessedTokens) * 100).toFixed(2));
  const criteria = {
    boundarySafety: boundaryViolations.length === 0,
    forcedFreshDemonstrated: observations.some((row) => row.forceFreshSession && !row.sessionReused),
    reuseRate: reuseRatePercent !== null && reuseRatePercent >= 70,
    tokenReduction: medianProcessedTokenReductionPercent !== null && medianProcessedTokenReductionPercent >= 25,
    compactRepeatContext: reused.length > 0 && reused.every((row) => row.contextMode === "delta"),
    functionalEquivalence: eligible.length > 0 && eligible.every((row) => row.functionalOutcomeMatched),
  };
  return {
    passed: Object.values(criteria).every(Boolean),
    targets: { reuseRatePercent: 70, medianProcessedTokenReductionPercent: 25 },
    sample: { observationCount: observations.length, eligibleRepeatCount: eligible.length, reusedRepeatCount: reused.length },
    metrics: { reuseRatePercent, controlMedianProcessedTokens, cohortMedianProcessedTokens, medianProcessedTokenReductionPercent },
    criteria, boundaryViolations,
  };
}
