import { describe, expect, it } from "vitest";
import type { IntegrationReconciliationReceipt } from "@paperclipai/shared";
import { evaluateParentIntegrationReconciliationFailures } from "../services/integration-reconciliation.js";

function receiptBody(overrides: Partial<IntegrationReconciliationReceipt> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    issueId: "child",
    source: { status: "done", updatedAt: "2026-09-07T12:00:00.000Z" },
    requiredIntegrations: ["clickup"],
    integrations: {
      clickup: {
        status: "healthy",
        projectionVersion: "pcv1:projection",
        taskId: "task-1",
        projectionHealthy: true,
        relationshipsHealthy: true,
        errorClass: null,
      },
    },
    ...overrides,
  });
}

describe("parent integration reconciliation barrier", () => {
  const updatedAt = new Date("2026-09-07T12:00:00.000Z");

  it("waits for terminal children and a current healthy required-integration receipt", () => {
    const liveChild = [{ id: "child", identifier: "STA-2", status: "in_progress", updatedAt }];
    expect(evaluateParentIntegrationReconciliationFailures(liveChild, new Map(), ["clickup"]))
      .toEqual([{ issueId: "child", identifier: "STA-2", reason: "child_not_terminal" }]);

    const doneChild = [{ ...liveChild[0]!, status: "done" }];
    expect(evaluateParentIntegrationReconciliationFailures(doneChild, new Map(), ["clickup"]))
      .toEqual([{ issueId: "child", identifier: "STA-2", reason: "integration_receipt_missing_or_stale" }]);
    expect(evaluateParentIntegrationReconciliationFailures(
      doneChild,
      new Map([["child", receiptBody({ source: { status: "in_progress", updatedAt: updatedAt.toISOString() } })]]),
      ["clickup"],
    )).toHaveLength(1);
    expect(evaluateParentIntegrationReconciliationFailures(
      doneChild,
      new Map([["child", receiptBody()]]),
      ["clickup"],
    )).toEqual([]);
  });

  it("keeps provider failures retryable without accepting a stale success", () => {
    const children = [{ id: "child", identifier: "STA-2", status: "done", updatedAt }];
    const failed = receiptBody({
      integrations: {
        clickup: {
          status: "retryable_failure",
          projectionVersion: "pcv1:projection",
          taskId: "task-1",
          projectionHealthy: true,
          relationshipsHealthy: false,
          errorClass: "clickup_relationship_readback_mismatch",
        },
      },
    });
    expect(evaluateParentIntegrationReconciliationFailures(
      children,
      new Map([["child", failed]]),
      ["clickup"],
    )).toHaveLength(1);
    expect(evaluateParentIntegrationReconciliationFailures(
      children,
      new Map([["child", receiptBody()]]),
      ["clickup"],
    )).toEqual([]);
  });
});
