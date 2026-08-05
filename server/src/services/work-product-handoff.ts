import type { IssueWorkProduct } from "@paperclipai/shared";
import { issueWorkProductMetadataSchema } from "@paperclipai/shared";

const HANDOFF_READY_STATUSES = new Set(["ready_for_review", "approved", "merged", "failed"]);

export interface WorkProductHandoffDecision {
  handoffKey: string;
  targetIssueId: string;
  nextOwnerAgentId: string;
  transitionKey: string;
  summary: string | null;
}

export function resolveWorkProductHandoff(
  product: Pick<IssueWorkProduct, "id" | "issueId" | "status" | "metadata">,
): WorkProductHandoffDecision | null {
  if (!HANDOFF_READY_STATUSES.has(product.status)) return null;
  const parsed = issueWorkProductMetadataSchema.safeParse(product.metadata);
  if (!parsed.success || !parsed.data.handoff) return null;
  const handoff = parsed.data.handoff;
  const targetIssueId = handoff.targetIssueId ?? product.issueId;
  return {
    handoffKey: `work_product_handoff:${targetIssueId}:${handoff.transitionKey}`,
    targetIssueId,
    nextOwnerAgentId: handoff.nextOwnerAgentId,
    transitionKey: handoff.transitionKey,
    summary: handoff.summary ?? null,
  };
}
