import { describe, expect, it } from "vitest";
import { evaluateSessionReusePilot } from "../services/session-reuse-pilot.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const row = (overrides: Record<string, unknown> = {}) => ({
  runId: crypto.randomUUID(), issueId, companyId, repeatWake: true, sessionReused: true,
  forceFreshSession: false, freshRequiredReasons: [], contextMode: "delta" as const,
  processedTokens: 700, functionalOutcomeMatched: true, ...overrides,
});
const evaluate = (observations: ReturnType<typeof row>[]) => evaluateSessionReusePilot({
  expectedIssueId: issueId, expectedCompanyId: companyId,
  cohort: { controlMedianProcessedTokens: 1_000, observations },
});

describe("evaluateSessionReusePilot", () => {
  it("passes at the reuse and token-reduction boundaries", () => {
    const observations = Array.from({ length: 10 }, (_, i) =>
      row({ sessionReused: i < 7, contextMode: i < 7 ? "delta" : "full" }));
    observations.push(row({ forceFreshSession: true, sessionReused: false, contextMode: "full" }));
    const result = evaluate(observations);
    expect(result.passed).toBe(true);
    expect(result).toMatchObject({ diagnosticOnly: true, terminalVerdict: null, realizedProductionSavings: false });
    expect(result.sample).toEqual({ observationCount: 11, eligibleRepeatCount: 10, reusedRepeatCount: 7 });
    expect(result.metrics).toMatchObject({ reuseRatePercent: 70, medianProcessedTokenReductionPercent: 30 });
  });

  it.each([
    [{ issueId: "33333333-3333-4333-8333-333333333333" }, "issue_changed"],
    [{ companyId: "44444444-4444-4444-8444-444444444444" }, "company_changed"],
    [{ freshRequiredReasons: ["model_changed"] }, "model_changed"],
    [{ freshRequiredReasons: ["instructions_changed"] }, "instructions_changed"],
    [{ freshRequiredReasons: ["environment_changed"] }, "environment_changed"],
    [{ freshRequiredReasons: ["credentials_changed"] }, "credentials_changed"],
    [{ freshRequiredReasons: ["security_bindings_changed"] }, "security_bindings_changed"],
    [{ freshRequiredReasons: ["configuration_changed"] }, "configuration_changed"],
  ])("reports reused fresh-required boundaries", (overrides, reason) => {
    const result = evaluate([row(overrides), row({ forceFreshSession: true, sessionReused: false })]);
    expect(result.criteria.boundarySafety).toBe(false);
    expect(result.boundaryViolations[0]?.reasons).toContain(reason);
  });

  it("requires forced-fresh behavior and excludes it from eligibility", () => {
    const result = evaluate([row(), row({ forceFreshSession: true, sessionReused: true, contextMode: "full" })]);
    expect(result.sample.eligibleRepeatCount).toBe(1);
    expect(result.criteria.forcedFreshDemonstrated).toBe(false);
    expect(result.criteria.boundarySafety).toBe(false);
  });

  it("checks equivalence and compact context independently of token savings", () => {
    const result = evaluate([
      row({ functionalOutcomeMatched: false, contextMode: "full", processedTokens: 100 }),
      row({ forceFreshSession: true, sessionReused: false }),
    ]);
    expect(result.criteria.tokenReduction).toBe(true);
    expect(result.criteria.functionalEquivalence).toBe(false);
    expect(result.criteria.compactRepeatContext).toBe(false);
  });
});
