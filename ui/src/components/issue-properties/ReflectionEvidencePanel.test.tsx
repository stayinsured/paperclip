// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/queryKeys";
import { ReflectionEvidencePanel } from "./ReflectionEvidencePanel";

vi.mock("../../lib/router", () => ({
  Link: ({ children, to, ...props }: { children: unknown; to: string }) => (
    <a href={to} {...props}>{children as string}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

describe("ReflectionEvidencePanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("renders every ledger state and inspectable receipt readback", () => {
    const issueId = "issue-1";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.issues.reflectionEvidence(issueId), {
      targets: [
        {
          id: "target-1",
          companyId: "company-1",
          issueId,
          proposalAgentId: "coach-1",
          sourceRunId: "proposal-run",
          proposalKey: "proposal-1",
          targetKey: "agent:agent-1:instructions",
          targetType: "agent_instructions",
          targetLabel: "Agent instructions",
          proposalRevision: "v1",
          proposedDiff: "accepted diff",
          evidenceMarkdown: "QA verified the readback.",
          state: "independently_validated",
          confirmationInteractionId: "interaction-1",
          applicationIssueId: "application-1",
          acceptedAt: null,
          appliedAt: null,
          validatedAt: null,
          validatedByAgentId: "qa-1",
          validatedByRunId: "qa-run",
          validatedByUserId: null,
          rejectedAt: null,
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
        },
        {
          id: "target-2",
          companyId: "company-1",
          issueId,
          proposalAgentId: "coach-1",
          sourceRunId: "proposal-run",
          proposalKey: "proposal-1",
          targetKey: "skills:scan-projects",
          targetType: "skills_scan",
          targetLabel: "Skill scan",
          proposalRevision: "v1",
          proposedDiff: null,
          evidenceMarkdown: "No change was justified.",
          state: "evidence_backed_no_change",
          confirmationInteractionId: null,
          applicationIssueId: null,
          acceptedAt: null,
          appliedAt: null,
          validatedAt: null,
          validatedByAgentId: null,
          validatedByRunId: null,
          validatedByUserId: null,
          rejectedAt: null,
          createdAt: "2026-08-31T00:00:01.000Z",
          updatedAt: "2026-08-31T00:00:01.000Z",
        },
      ],
      receipts: [{
        id: "receipt-1",
        companyId: "company-1",
        issueId,
        ledgerTargetId: "target-1",
        targetKey: "agent:agent-1:instructions",
        targetType: "agent_instructions",
        targetLabel: "Agent instructions",
        targetAgentId: "agent-1",
        acceptedInteractionId: "interaction-1",
        applicationIssueId: "application-1",
        actorAgentId: "coach-1",
        actorRunId: "apply-run",
        instructionPath: "AGENTS.md",
        beforeContent: "# Before",
        appliedDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md",
        postWriteContent: "# After",
        createdAt: "2026-08-31T00:00:02.000Z",
      }],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ReflectionEvidencePanel issueId={issueId} />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Reflection evidence");
    expect(container.textContent).toContain("Validated");
    expect(container.textContent).toContain("No change");
    expect(container.textContent).toContain("Exact applied diff");
    expect(container.textContent).toContain("Authoritative post-write content");
    expect(container.textContent).toContain("# After");
    expect(container.querySelector('a[href="/issues/application-1"]')).not.toBeNull();
  });
});
