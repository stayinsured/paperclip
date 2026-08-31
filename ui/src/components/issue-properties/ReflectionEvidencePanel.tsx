import { useQuery } from "@tanstack/react-query";
import type { InstructionMutationReceipt, ReflectionLedgerTarget } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { Link } from "../../lib/router";
import { PropertyChip, PropertyRow, PropertySection } from "./primitives";

const STATE_LABELS: Record<ReflectionLedgerTarget["state"], string> = {
  proposed: "Proposed",
  pending: "Pending",
  accepted: "Accepted",
  applied: "Applied",
  independently_validated: "Validated",
  rejected: "Rejected",
  evidence_backed_no_change: "No change",
};

function ReceiptDetails({ receipt }: { receipt: InstructionMutationReceipt }) {
  return (
    <div className="space-y-2 border-l border-border pl-3 text-xs">
      <div className="space-y-1 text-muted-foreground">
        <div>Path: <span className="font-mono text-foreground">{receipt.instructionPath}</span></div>
        <div>Accepted interaction: <span className="font-mono text-foreground">{receipt.acceptedInteractionId}</span></div>
        <div>
          Apply issue:{" "}
          <Link className="font-mono text-foreground hover:underline" to={`/issues/${receipt.applicationIssueId}`}>
            {receipt.applicationIssueId}
          </Link>
        </div>
        <div>Actor run: <span className="font-mono text-foreground">{receipt.actorRunId}</span></div>
      </div>
      <details>
        <summary className="cursor-pointer text-muted-foreground">Exact applied diff</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-foreground">
          {receipt.appliedDiff || "No content difference"}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-muted-foreground">Authoritative post-write content</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-foreground">
          {receipt.postWriteContent}
        </pre>
      </details>
    </div>
  );
}

export function ReflectionEvidencePanel({ issueId }: { issueId: string }) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.issues.reflectionEvidence(issueId),
    queryFn: () => issuesApi.getReflectionEvidence(issueId),
  });
  if (isError) {
    return (
      <PropertySection title="Reflection evidence" first>
        <PropertyRow label="Evidence">Unable to load reflection evidence.</PropertyRow>
      </PropertySection>
    );
  }
  if (!data || data.targets.length === 0) return null;

  const receiptsByTarget = new Map(data.receipts.map((receipt) => [receipt.ledgerTargetId, receipt]));
  return (
    <PropertySection title="Reflection evidence" first>
      {data.targets.map((target) => {
        const receipt = receiptsByTarget.get(target.id);
        return (
          <PropertyRow key={target.id} label={target.targetLabel} wrap>
            <details className="w-full min-w-0">
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <PropertyChip>{STATE_LABELS[target.state]}</PropertyChip>
                <span className="truncate font-mono text-xs text-muted-foreground">{target.targetKey}</span>
              </summary>
              <div className="mt-2 space-y-2">
                {target.evidenceMarkdown ? (
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">{target.evidenceMarkdown}</p>
                ) : null}
                {receipt ? <ReceiptDetails receipt={receipt} /> : null}
              </div>
            </details>
          </PropertyRow>
        );
      })}
    </PropertySection>
  );
}
