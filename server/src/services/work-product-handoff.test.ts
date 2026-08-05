import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveWorkProductHandoff } from "./work-product-handoff.js";

describe("resolveWorkProductHandoff", () => {
  it("emits one stable transition key for completed work products", () => {
    const issueId = randomUUID();
    const ownerId = randomUUID();
    const first = resolveWorkProductHandoff({
      id: randomUUID(),
      issueId,
      status: "ready_for_review",
      metadata: {
        handoff: {
          transitionKey: "fast-gate-complete",
          nextOwnerAgentId: ownerId,
          summary: "CI passed without provider mutations.",
        },
      },
    });
    const duplicateTransition = resolveWorkProductHandoff({
      id: randomUUID(),
      issueId,
      status: "approved",
      metadata: {
        handoff: {
          transitionKey: "fast-gate-complete",
          nextOwnerAgentId: ownerId,
        },
      },
    });

    expect(first).toMatchObject({
      handoffKey: `work_product_handoff:${issueId}:fast-gate-complete`,
      targetIssueId: issueId,
      nextOwnerAgentId: ownerId,
    });
    expect(duplicateTransition?.handoffKey).toBe(first?.handoffKey);
  });

  it("does not hand off draft work or malformed declarations", () => {
    expect(resolveWorkProductHandoff({
      id: randomUUID(),
      issueId: randomUUID(),
      status: "draft",
      metadata: { handoff: { transitionKey: "draft" } },
    })).toBeNull();
  });
});
