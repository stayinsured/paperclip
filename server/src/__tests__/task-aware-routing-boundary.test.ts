import { describe, expect, it } from "vitest";
import {
  classifyShadowPilot,
  decideShadowRouting,
  parseDecision,
  persistShadowRoutingDecision,
} from "../services/task-aware-routing.js";

describe("server-owned shadow routing boundary", () => {
  it("does not enroll a run without a persisted issue", () => {
    const pilot = classifyShadowPilot({ issue: null, wakeReason: "issue_assigned", scheduledRetryAttempt: 0 });
    expect(pilot).toBeNull();
    expect(persistShadowRoutingDecision({ ok: true }, decideShadowRouting(pilot, null))).toEqual({ ok: true });
  });

  it("classifies a routine issue and persists a readable completed-run decision", () => {
    const pilot = classifyShadowPilot({
      issue: {
        title: "Verify webhook delivery report",
        description: "Read back the sandbox result",
        workMode: "standard",
        status: "in_progress",
      },
      wakeReason: "issue_assigned",
      scheduledRetryAttempt: 0,
    });
    const decision = decideShadowRouting(pilot, null);
    expect(pilot?.taskClass).toBe("read_only_check");
    expect(decision).toMatchObject({ proposedLane: "economy", appliedLane: "strongest" });
    const completedResult = persistShadowRoutingDecision({ summary: "done" }, decision);
    expect(parseDecision(completedResult.paperclipRoutingDecision)).toEqual(decision);
  });

  it("never changes the applied lane on a protected issue", () => {
    const pilot = classifyShadowPilot({
      issue: { title: "Deploy production release", description: null, workMode: "standard", status: "in_progress" },
      wakeReason: "issue_assigned",
      scheduledRetryAttempt: 0,
    });
    expect(decideShadowRouting(pilot, null)).toMatchObject({ proposedLane: "strongest", appliedLane: "strongest" });
  });
});
