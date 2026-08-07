import { clickUpSha256 } from "./identity.js";

export interface ClickUpProjectionTiming {
  sourceUpdatedAt: string;
  projectedAt: string | null;
}

export interface ClickUpProjectionHealth {
  sampleCount: number;
  p95FreshnessMs: number | null;
  oldestLagMs: number;
  status: "healthy" | "degraded";
  exception: null | {
    exceptionKey: string;
    kind: "projection_lag";
    summary: string;
    lagMs: number;
  };
}

export function calculateClickUpProjectionHealth(input: {
  companyId: string;
  listId: string;
  timings: ClickUpProjectionTiming[];
  now?: Date;
}): ClickUpProjectionHealth {
  const nowMs = (input.now ?? new Date()).getTime();
  const completedDurations: number[] = [];
  let oldestLagMs = 0;
  for (const timing of input.timings) {
    const sourceMs = Date.parse(timing.sourceUpdatedAt);
    if (!Number.isFinite(sourceMs)) continue;
    const projectedMs = timing.projectedAt == null ? null : Date.parse(timing.projectedAt);
    if (projectedMs != null && Number.isFinite(projectedMs) && projectedMs >= sourceMs) {
      completedDurations.push(projectedMs - sourceMs);
    }
    const observedUntil = projectedMs != null && Number.isFinite(projectedMs) ? projectedMs : nowMs;
    oldestLagMs = Math.max(oldestLagMs, Math.max(0, observedUntil - sourceMs));
  }
  completedDurations.sort((left, right) => left - right);
  const percentileIndex = completedDurations.length === 0
    ? -1
    : Math.max(0, Math.ceil(completedDurations.length * 0.95) - 1);
  const p95FreshnessMs = percentileIndex === -1 ? null : completedDurations[percentileIndex]!;
  const alerting = oldestLagMs > 15 * 60 * 1_000;
  return {
    sampleCount: completedDurations.length,
    p95FreshnessMs,
    oldestLagMs,
    status: alerting ? "degraded" : "healthy",
    exception: alerting
      ? {
          exceptionKey: `clickup-lag:${clickUpSha256(`${input.companyId}\u0000${input.listId}`)}`,
          kind: "projection_lag",
          summary: "ClickUp projection lag exceeded 15 minutes",
          lagMs: oldestLagMs,
        }
      : null,
  };
}
