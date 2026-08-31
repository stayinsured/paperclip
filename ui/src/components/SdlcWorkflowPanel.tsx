import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, ShieldCheck } from "lucide-react";
import type { Agent, Issue, IssueDocument } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  deriveSdlcWorkflowSummary,
  parseSdlcEvidenceRegistry,
  type SdlcGateState,
  type SdlcMatrixRow,
  type SdlcMatrixState,
  type SdlcWorkflowSummary,
} from "../lib/sdlc-workflow";
import { cn } from "../lib/utils";
import { Link } from "../lib/router";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";

const SDLC_EVIDENCE_DOCUMENT_KEY = "sdlc-evidence";

function matrixBadge(state: SdlcMatrixState) {
  const label = state === "pass" ? "Pass" : state === "fail" ? "Blocked" : state === "waived" ? "Waived" : "Missing";
  const variant = state === "fail" ? "destructive" : state === "pass" ? "default" : state === "waived" ? "outline" : "secondary";
  return <Badge variant={variant}>{label}</Badge>;
}

function gateBadge(state: SdlcGateState) {
  const label = state === "accepted"
    ? "Accepted"
    : state === "pending"
      ? "Board decision"
      : state === "rejected"
        ? "Rejected"
        : state === "stale"
          ? "Stale"
          : state === "failed"
            ? "Needs retry"
            : "Not requested";
  return <Badge variant={["rejected", "stale", "failed"].includes(state) ? "destructive" : state === "accepted" ? "default" : "secondary"}>{label}</Badge>;
}

function Matrix({ title, rows }: { title: string; rows: SdlcMatrixRow[] }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div className="divide-y divide-border rounded-md border border-border">
        {rows.map((row) => (
          <div key={row.id} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-foreground">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.detail}</p>
            </div>
            <div className="shrink-0">{matrixBadge(row.state)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkflowError({ message }: { message: string }) {
  return (
    <section
      data-testid="sdlc-workflow-error"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <p className="font-medium">Workflow evidence is unavailable</p>
      <p className="mt-1 text-xs">{message} The lifecycle record must be repaired before this view can prove start or closure readiness.</p>
    </section>
  );
}

export function SdlcWorkflowPanelContent({ summary }: { summary: SdlcWorkflowSummary }) {
  return (
    <section data-testid="sdlc-workflow-panel" className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 rounded-md bg-muted p-2 text-foreground" aria-hidden="true">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Workflow &amp; evidence</h3>
            <p className="text-xs text-muted-foreground">Decision, start, and closure readiness from the lifecycle registry.</p>
          </div>
        </div>
        {summary.riskClass ? <Badge variant="outline">Risk {summary.riskClass}</Badge> : null}
      </div>

      <div className="space-y-4 p-4">
        <div
          data-decision-state={summary.decision.state}
          className={cn(
            "rounded-md border px-3 py-2",
            summary.decision.state === "blocked"
              ? "border-destructive/40 bg-destructive/10"
              : summary.decision.state === "action"
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-muted/40",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{summary.decision.label}</p>
            {summary.decision.owner ? <Badge variant="outline">Owner: {summary.decision.owner}</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{summary.decision.detail}</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {[summary.gate1, summary.gate2].map((gate) => (
            <div key={gate.gate} data-gate-state={gate.state} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{gate.label}</p>
                {gateBadge(gate.state)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{gate.reason ?? gate.detail}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Matrix title="Ready to start" rows={summary.startRows} />
          <Matrix title="Ready to close" rows={summary.completionRows} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2" aria-label="Provider sync">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider sync</h4>
            <div className="divide-y divide-border rounded-md border border-border">
              {summary.providers.map((provider) => (
                <div key={provider.provider} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium capitalize">{provider.provider}</p>
                    <p className="text-xs text-muted-foreground">{provider.detail}</p>
                  </div>
                  <div className="shrink-0">{matrixBadge(provider.state)}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2" aria-label="Evidence links">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence links</h4>
            <div className="rounded-md border border-border px-3 py-2">
              {summary.evidenceLinks.length > 0 ? (
                <ul className="space-y-1.5">
                  {summary.evidenceLinks.map((link) => (
                    <li key={link.id}>
                      <a className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4" href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No linkable PR, check, QA, UAT, or provider evidence is recorded.</p>
              )}
            </div>
          </section>
        </div>

        {summary.tasks.length > 0 ? (
          <details className="group rounded-md border border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
              <span>Planned task readiness ({summary.tasks.length})</span>
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Task</th>
                    <th className="px-3 py-2 font-medium">Planned owner</th>
                    <th className="px-3 py-2 font-medium">Estimate / due</th>
                    <th className="px-3 py-2 font-medium">Start</th>
                    <th className="px-3 py-2 font-medium">Close</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.tasks.map((task) => (
                    <tr key={task.issueId}>
                      <td className="min-w-56 px-3 py-2 align-top">
                        {task.identifier ? (
                          <Link className="font-medium underline underline-offset-4" to={createIssueDetailPath(task.identifier)}>{task.identifier}</Link>
                        ) : <span className="font-medium">Unlinked</span>}
                        <p className="mt-0.5 text-muted-foreground">{task.title}</p>
                      </td>
                      <td className="px-3 py-2 align-top">{task.plannedOwner}</td>
                      <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">{[task.estimate, task.dueDate].filter(Boolean).join(" · ") || "Not recorded"}</td>
                      <td className="min-w-44 px-3 py-2 align-top">{matrixBadge(task.startState)}<p className="mt-1 text-muted-foreground">{task.startDetail}</p></td>
                      <td className="min-w-44 px-3 py-2 align-top">{matrixBadge(task.completionState)}<p className="mt-1 text-muted-foreground">{task.completionDetail}</p></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

export function SdlcWorkflowPanel({ issue, agentMap }: { issue: Issue; agentMap: ReadonlyMap<string, Agent> }) {
  const rootIssueId = issue.ancestors?.at(-1)?.id ?? issue.id;
  const rootIssueQuery = useQuery({
    queryKey: queryKeys.issues.detail(rootIssueId),
    queryFn: () => issuesApi.get(rootIssueId),
    enabled: rootIssueId !== issue.id,
  });
  const rootIssue = rootIssueId === issue.id ? issue : rootIssueQuery.data;
  const documentsQuery = useQuery({
    queryKey: queryKeys.issues.documentsIncludingSystem(rootIssueId),
    queryFn: () => issuesApi.listDocuments(rootIssueId, { includeSystem: true }),
    enabled: Boolean(rootIssue),
  });
  const evidenceSummary = documentsQuery.data?.find((document) => document.key === SDLC_EVIDENCE_DOCUMENT_KEY) ?? null;
  const evidenceQuery = useQuery({
    queryKey: queryKeys.issues.document(rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY),
    queryFn: () => issuesApi.getDocument(rootIssueId, SDLC_EVIDENCE_DOCUMENT_KEY),
    enabled: Boolean(evidenceSummary),
  });
  const interactionsQuery = useQuery({
    queryKey: queryKeys.issues.interactions(rootIssueId),
    queryFn: () => issuesApi.listInteractions(rootIssueId),
    enabled: Boolean(evidenceSummary),
  });
  const treeIssuesQuery = useQuery({
    queryKey: queryKeys.issues.listByDescendantRoot(issue.companyId, rootIssueId),
    queryFn: () => issuesApi.list(issue.companyId, { descendantOf: rootIssueId, includeBlockedBy: true }),
    enabled: Boolean(evidenceSummary),
  });
  const agentNameById = useMemo(
    () => new Map([...agentMap.entries()].map(([id, agent]) => [id, agent.name])),
    [agentMap],
  );

  if (rootIssueQuery.error || documentsQuery.error || evidenceQuery.error || interactionsQuery.error || treeIssuesQuery.error) {
    const error = rootIssueQuery.error ?? documentsQuery.error ?? evidenceQuery.error ?? interactionsQuery.error ?? treeIssuesQuery.error;
    return <WorkflowError message={error instanceof Error ? error.message : "The lifecycle readback failed."} />;
  }
  if (documentsQuery.isLoading || (evidenceSummary && (evidenceQuery.isLoading || interactionsQuery.isLoading || treeIssuesQuery.isLoading))) {
    return <Skeleton className="h-28 w-full rounded-lg" />;
  }
  if (!rootIssue || !evidenceSummary || !evidenceQuery.data) return null;

  const parsed = parseSdlcEvidenceRegistry((evidenceQuery.data as IssueDocument).body);
  if (parsed.error) return <WorkflowError message={parsed.error} />;
  const hasClassification = parsed.records.some((record) => record.type === "classification" && record.companyId === issue.companyId);
  if (!hasClassification) return null;

  const summary = deriveSdlcWorkflowSummary({
    rootIssue,
    currentIssue: issue,
    treeIssues: treeIssuesQuery.data ?? [],
    records: parsed.records,
    interactions: interactionsQuery.data ?? [],
    agentNameById,
  });
  return <SdlcWorkflowPanelContent summary={summary} />;
}
