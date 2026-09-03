import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";

export type SdlcMatrixState = "pass" | "pending" | "fail" | "waived";
export type SdlcGateState = "accepted" | "pending" | "rejected" | "stale" | "failed" | "missing";

export interface SdlcEvidenceRecord {
  id: string;
  type: string;
  companyId: string;
  issueId: string;
  createdAt?: string;
  actorAgentId?: string | null;
  actorRunId?: string | null;
  supersedeOf?: string | null;
  [key: string]: unknown;
}

export type SdlcEvidenceParseResult =
  | { records: SdlcEvidenceRecord[]; error: null }
  | { records: []; error: string };

export interface SdlcMatrixRow {
  id: string;
  label: string;
  detail: string;
  state: SdlcMatrixState;
}

export interface SdlcGateSummary {
  gate: "gate1" | "gate2";
  label: string;
  state: SdlcGateState;
  detail: string;
  reason: string | null;
  interactionId: string | null;
}

export interface SdlcDecisionSummary {
  owner: "board" | "delivery" | "reviewer" | null;
  label: string;
  detail: string;
  state: "action" | "blocked" | "clear";
}

export interface SdlcProviderSummary {
  provider: string;
  state: SdlcMatrixState;
  detail: string;
}

export interface SdlcEvidenceLink {
  id: string;
  label: string;
  href: string;
}

export interface SdlcTaskSummary {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  plannedOwner: string;
  estimate: string | null;
  dueDate: string | null;
  startState: SdlcMatrixState;
  startDetail: string;
  completionState: SdlcMatrixState;
  completionDetail: string;
}

export interface SdlcWorkflowSummary {
  riskClass: string | null;
  gate1: SdlcGateSummary;
  gate2: SdlcGateSummary;
  decision: SdlcDecisionSummary;
  startRows: SdlcMatrixRow[];
  completionRows: SdlcMatrixRow[];
  providers: SdlcProviderSummary[];
  evidenceLinks: SdlcEvidenceLink[];
  tasks: SdlcTaskSummary[];
}

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const PASS_OUTCOMES = new Set(["pass", "passed", "accepted", "verified", "success", "succeeded", "clean"]);
const FAIL_OUTCOMES = new Set(["fail", "failed", "rejected", "error", "partial"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function activeRecords(records: SdlcEvidenceRecord[]): SdlcEvidenceRecord[] {
  const superseded = new Set(
    records.map((record) => record.supersedeOf).filter((value): value is string => typeof value === "string"),
  );
  return records.filter((record) => !superseded.has(record.id));
}

function latestRecord(
  records: SdlcEvidenceRecord[],
  type: string,
  predicate: (record: SdlcEvidenceRecord) => boolean = () => true,
): SdlcEvidenceRecord | null {
  let latest: SdlcEvidenceRecord | null = null;
  for (const record of records) {
    if (record.type !== type || !predicate(record)) continue;
    if (!latest || timestamp(record.createdAt) >= timestamp(latest.createdAt)) latest = record;
  }
  return latest;
}

export function parseSdlcEvidenceRegistry(body: string): SdlcEvidenceParseResult {
  const records: SdlcEvidenceRecord[] = [];
  for (const [index, line] of body.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const candidate = asRecord(JSON.parse(trimmed));
      if (
        !candidate
        || !readString(candidate, "id")
        || !readString(candidate, "type")
        || !readString(candidate, "companyId")
        || !readString(candidate, "issueId")
      ) {
        return { records: [], error: `Evidence line ${index + 1} has an invalid lifecycle envelope.` };
      }
      records.push(candidate as SdlcEvidenceRecord);
    } catch {
      return { records: [], error: `Evidence line ${index + 1} is not valid JSON.` };
    }
  }
  return { records, error: null };
}

export function extractSdlcAcceptanceCriteria(description: string | null | undefined) {
  if (!description) return [] as Array<{ rowId: string; text: string }>;
  const rows: Array<{ rowId: string; text: string }> = [];
  let inSection = false;
  for (const line of description.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      inSection = heading[1]?.trim().toLowerCase() === "acceptance criteria";
      continue;
    }
    if (!inSection) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
    const text = bullet?.[1]?.trim();
    if (text) rows.push({ rowId: `ac-${rows.length + 1}`, text });
  }
  return rows;
}

export function extractSdlcPlanningMetadata(description: string | null | undefined) {
  const owner = /(?:^|\n)\s*(?:[-*]\s*)?Planned owner:\s*([^\n]+)/i.exec(description ?? "")?.[1]?.trim().replace(/\.$/, "") ?? null;
  const estimateLine = /(?:^|\n)\s*(?:[-*]\s*)?Estimate:\s*([^\n]+)/i.exec(description ?? "")?.[1]?.trim() ?? null;
  const dueDate = /\bdue\s+(\d{4}-\d{2}-\d{2})\b/i.exec(estimateLine ?? description ?? "")?.[1] ?? null;
  const estimate = estimateLine?.split(";")[0]?.trim().replace(/\.$/, "") || null;
  return { owner, estimate, dueDate };
}

function gateBinding(interaction: IssueThreadInteraction, rootIssueId: string) {
  if (interaction.kind !== "request_confirmation") return null;
  const key = interaction.idempotencyKey ?? "";
  const prefix = `confirmation:${rootIssueId}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const gate1 = /^plan:([^:]+)$/.exec(rest);
  if (gate1) return { gate: "gate1" as const, revisionId: gate1[1]!, graphRev: null };
  const gate2 = /^start:([^:]+)(?::g(\d+))?$/.exec(rest);
  if (gate2) return { gate: "gate2" as const, revisionId: gate2[1]!, graphRev: gate2[2] ?? null };
  return null;
}

function latestGateInteraction(
  interactions: IssueThreadInteraction[],
  rootIssueId: string,
  gate: "gate1" | "gate2",
) {
  return interactions
    .filter((interaction) => gateBinding(interaction, rootIssueId)?.gate === gate)
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
}

function interactionReason(interaction: IssueThreadInteraction | null): string | null {
  return interaction?.kind === "request_confirmation" ? interaction.result?.reason ?? null : null;
}

function deriveGateSummary(input: {
  gate: "gate1" | "gate2";
  rootIssueId: string;
  currentPlanRevisionId: string | null;
  currentGraphRev: string | null;
  records: SdlcEvidenceRecord[];
  interactions: IssueThreadInteraction[];
}): SdlcGateSummary {
  const label = input.gate === "gate1" ? "Gate 1 · plan approval" : "Gate 2 · start authorization";
  const interaction = latestGateInteraction(input.interactions, input.rootIssueId, input.gate);
  const binding = interaction ? gateBinding(interaction, input.rootIssueId) : null;
  const decision = latestRecord(input.records, "gate_decision", (record) => readString(record, "gate") === input.gate);
  const verdict = readString(decision, "verdict");
  const boundRevision = readString(decision, "revisionId") ?? binding?.revisionId ?? null;
  const boundGraphRev = readString(decision, "graphRev") ?? binding?.graphRev ?? null;
  const staleRevision = Boolean(
    (verdict === "accepted" || interaction?.status === "accepted")
    && input.currentPlanRevisionId
    && boundRevision
    && input.currentPlanRevisionId !== boundRevision,
  );
  const staleGraph = Boolean(
    input.gate === "gate2"
    && (verdict === "accepted" || interaction?.status === "accepted")
    && input.currentGraphRev
    && boundGraphRev
    && input.currentGraphRev !== boundGraphRev,
  );
  if (staleRevision || staleGraph) {
    return {
      gate: input.gate,
      label,
      state: "stale",
      detail: staleRevision
        ? "Approval targets an older plan revision."
        : "Approval targets an older provisioned task graph.",
      reason: "A fresh revision-bound confirmation is required.",
      interactionId: interaction?.id ?? null,
    };
  }
  if (interaction?.status === "pending") {
    return {
      gate: input.gate,
      label,
      state: "pending",
      detail: interaction.kind === "request_confirmation" ? interaction.payload.prompt : "Board confirmation is pending.",
      reason: null,
      interactionId: interaction.id,
    };
  }
  const accepted = interaction?.status === "accepted" || verdict === "accepted";
  if (accepted) {
    const bindingLabel = boundRevision ? `Plan ${boundRevision.slice(0, 8)}` : "Bound revision";
    return {
      gate: input.gate,
      label,
      state: "accepted",
      detail: input.gate === "gate2" && boundGraphRev
        ? `${bindingLabel}, graph ${boundGraphRev}`
        : bindingLabel,
      reason: null,
      interactionId: interaction?.id ?? null,
    };
  }
  const rejected = interaction?.status === "rejected" || verdict === "rejected";
  if (rejected) {
    return {
      gate: input.gate,
      label,
      state: "rejected",
      detail: "The requested decision was rejected.",
      reason: interactionReason(interaction) ?? readString(decision, "reason") ?? "No rejection reason was recorded.",
      interactionId: interaction?.id ?? null,
    };
  }
  if (interaction && ["failed", "expired", "cancelled"].includes(interaction.status)) {
    return {
      gate: input.gate,
      label,
      state: "failed",
      detail: `The latest confirmation is ${interaction.status}.`,
      reason: interactionReason(interaction),
      interactionId: interaction.id,
    };
  }
  return {
    gate: input.gate,
    label,
    state: "missing",
    detail: "No current revision-bound confirmation is recorded.",
    reason: null,
    interactionId: null,
  };
}

function recordTargetsIssue(record: SdlcEvidenceRecord, issueId: string): boolean {
  return record.issueId === issueId || readString(record, "childIssueId") === issueId;
}

function rowCoverage(records: SdlcEvidenceRecord[], issueId: string, rowId: string) {
  for (const record of records) {
    if (!recordTargetsIssue(record, issueId)) continue;
    const rowIds = [readString(record, "rowId"), ...readStringArray(record, "rowIds"), ...readStringArray(record, "rowsPassed")]
      .filter((value): value is string => Boolean(value));
    if (!rowIds.includes(rowId)) continue;
    if (record.type === "waiver") return { state: "waived" as const, record };
    const outcome = (readString(record, "verdict") ?? readString(record, "result") ?? "").toLowerCase();
    if (PASS_OUTCOMES.has(outcome)) return { state: "pass" as const, record };
    if (FAIL_OUTCOMES.has(outcome)) return { state: "fail" as const, record };
  }
  return { state: "pending" as const, record: null };
}

function outcomeState(record: SdlcEvidenceRecord): SdlcMatrixState {
  const outcome = (readString(record, "outcome") ?? readString(record, "result") ?? readString(record, "verdict") ?? "").toLowerCase();
  if (PASS_OUTCOMES.has(outcome)) return "pass";
  if (FAIL_OUTCOMES.has(outcome)) return "fail";
  const driftCounts = record.driftCounts;
  const driftTotal = typeof driftCounts === "number"
    ? driftCounts
    : Object.values(asRecord(driftCounts) ?? {}).reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0,
      );
  if (driftTotal > 0) return "fail";
  if (record.type === "provider_readback" && record.verifiedFields) return "pass";
  return "pending";
}

function providerSummaries(records: SdlcEvidenceRecord[]): SdlcProviderSummary[] {
  const relevant = records.filter((record) =>
    record.type === "provider_readback"
    || record.type === "reconciliation_summary"
    || (record.type === "provisioning_write" && readString(record, "provider") !== "paperclip"),
  );
  const latestByProvider = new Map<string, SdlcEvidenceRecord>();
  for (const record of relevant) {
    const provider = readString(record, "provider") ?? "External provider";
    const previous = latestByProvider.get(provider);
    if (!previous || timestamp(record.createdAt) >= timestamp(previous.createdAt)) latestByProvider.set(provider, record);
  }
  if (latestByProvider.size === 0) {
    return [{ provider: "External providers", state: "pending", detail: "No verified provider readback is recorded." }];
  }
  return [...latestByProvider.entries()].map(([provider, record]) => {
    const state = outcomeState(record);
    const driftCounts = asRecord(record.driftCounts);
    const driftTotal = Object.values(driftCounts ?? {}).reduce<number>(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0,
    );
    return {
      provider,
      state,
      detail: state === "pass"
        ? "Latest readback is verified."
        : state === "fail"
          ? driftTotal > 0
            ? `${driftTotal} unresolved drift item${driftTotal === 1 ? "" : "s"}.`
            : readString(record, "reason") ?? "Latest provider evidence reports a failure."
          : "A verified readback is still required.",
    };
  });
}

function evidenceLinks(records: SdlcEvidenceRecord[]): SdlcEvidenceLink[] {
  const fields = ["prUrl", "evidenceUrl", "url", "href"] as const;
  const links: SdlcEvidenceLink[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const field of fields) {
      const href = readString(record, field);
      if (!href || !/^https?:\/\//i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const provider = readString(record, "provider");
      links.push({
        id: `${record.id}:${field}`,
        label: provider ? `${provider} ${record.type.replaceAll("_", " ")}` : record.type.replaceAll("_", " "),
        href,
      });
    }
  }
  return links;
}

function evidenceForIssue(records: SdlcEvidenceRecord[], issue: Pick<Issue, "id" | "description">) {
  const acceptanceRows = extractSdlcAcceptanceCriteria(issue.description);
  const coverageRows = acceptanceRows.map((row) => {
    const coverage = rowCoverage(records, issue.id, row.rowId);
    return {
      id: row.rowId,
      label: row.text,
      state: coverage.state,
      detail: coverage.state === "pass"
        ? `Covered by ${coverage.record?.type.replaceAll("_", " ")}.`
        : coverage.state === "waived"
          ? "Waived with an owner and rationale."
          : coverage.state === "fail"
            ? "Recorded evidence failed this row."
            : "Missing check, QA, UAT, or waiver evidence.",
    } satisfies SdlcMatrixRow;
  });
  return coverageRows.length > 0
    ? coverageRows
    : [{ id: "acceptance:none", label: "Acceptance criteria", state: "pass", detail: "No explicit acceptance rows are defined." } satisfies SdlcMatrixRow];
}

function taskSummaries(input: {
  records: SdlcEvidenceRecord[];
  treeIssues: Issue[];
  gate2: SdlcGateSummary;
  agentNameById: ReadonlyMap<string, string>;
}): SdlcTaskSummary[] {
  const issueById = new Map(input.treeIssues.map((issue) => [issue.id, issue]));
  return input.records
    .filter((record) => record.type === "provisioning_write" && readString(record, "op") === "provision_task")
    .map((record) => {
      const childIssueId = readString(record, "childIssueId") ?? "";
      const issue = issueById.get(childIssueId);
      const metadata = extractSdlcPlanningMetadata(issue?.description);
      const plannedOwnerId = readString(record, "plannedAssigneeAgentId");
      const unresolvedBlockers = issue?.blockedBy?.filter((blocker) => !TERMINAL_STATUSES.has(blocker.status)) ?? [];
      const acceptanceRows = issue ? evidenceForIssue(input.records, issue) : [];
      const missingEvidence = acceptanceRows.filter((row) => row.state === "pending" || row.state === "fail").length;
      const startPassed = Boolean(issue && issue.status !== "backlog") || (
        input.gate2.state === "accepted" && unresolvedBlockers.length === 0
      );
      const completionPassed = Boolean(issue && TERMINAL_STATUSES.has(issue.status));
      return {
        issueId: childIssueId,
        identifier: issue?.identifier ?? null,
        title: issue?.title ?? readString(record, "taskKey") ?? "Provisioned task",
        status: issue?.status ?? "missing",
        plannedOwner: (plannedOwnerId && input.agentNameById.get(plannedOwnerId)) ?? metadata.owner ?? "Unresolved owner",
        estimate: metadata.estimate,
        dueDate: metadata.dueDate,
        startState: startPassed ? "pass" : "pending",
        startDetail: issue?.status !== "backlog"
          ? `Started (${issue?.status ?? "unknown"}).`
          : unresolvedBlockers.length > 0
            ? `Waiting on ${unresolvedBlockers.map((blocker) => blocker.identifier ?? blocker.title).join(", ")}.`
            : input.gate2.state === "accepted"
              ? "Ready to activate."
              : "Waiting for Gate 2.",
        completionState: completionPassed ? "pass" : "pending",
        completionDetail: completionPassed
          ? `Terminal (${issue?.status}).`
          : issue
            ? `${missingEvidence} acceptance evidence item${missingEvidence === 1 ? "" : "s"} missing.`
            : "Provisioned task readback is missing.",
      };
    });
}

export function deriveSdlcWorkflowSummary(input: {
  rootIssue: Issue;
  currentIssue: Issue;
  treeIssues: Issue[];
  records: SdlcEvidenceRecord[];
  interactions: IssueThreadInteraction[];
  agentNameById?: ReadonlyMap<string, string>;
}): SdlcWorkflowSummary {
  const records = activeRecords(input.records.filter((record) => record.companyId === input.rootIssue.companyId));
  const currentPlanRevisionId = input.rootIssue.planDocument?.latestRevisionId ?? null;
  const provisioning = latestRecord(records, "provisioning_complete");
  const currentGraphRev = readString(provisioning, "graphRev");
  const gate1 = deriveGateSummary({
    gate: "gate1",
    rootIssueId: input.rootIssue.id,
    currentPlanRevisionId,
    currentGraphRev,
    records,
    interactions: input.interactions,
  });
  const gate2 = deriveGateSummary({
    gate: "gate2",
    rootIssueId: input.rootIssue.id,
    currentPlanRevisionId,
    currentGraphRev,
    records,
    interactions: input.interactions,
  });
  const classification = latestRecord(records, "classification");
  const dor = latestRecord(records, "dor_validated", (record) =>
    !currentPlanRevisionId || readString(record, "revisionId") === currentPlanRevisionId,
  );
  const dorMissingRows = Array.isArray(dor?.missingRows) ? dor.missingRows.length : 0;
  const dorPassed = readString(dor, "result") === "pass" && dorMissingRows === 0;
  const unresolvedBlockers = input.currentIssue.id === input.rootIssue.id
    ? []
    : input.currentIssue.blockedBy?.filter((blocker) => !TERMINAL_STATUSES.has(blocker.status)) ?? [];
  const startRows: SdlcMatrixRow[] = [
    {
      id: "dor",
      label: "Plan readiness (DoR)",
      state: dorPassed ? "pass" : dor ? "fail" : "pending",
      detail: dorPassed
        ? "The current plan revision passed readiness validation."
        : dor
          ? `${dorMissingRows} readiness row${dorMissingRows === 1 ? "" : "s"} missing.`
          : "Current-revision readiness evidence is missing.",
    },
    { id: "gate1", label: gate1.label, state: gate1.state === "accepted" ? "pass" : gate1.state === "pending" || gate1.state === "missing" ? "pending" : "fail", detail: gate1.reason ?? gate1.detail },
    {
      id: "provisioning",
      label: "Task graph readback",
      state: provisioning ? "pass" : "pending",
      detail: provisioning
        ? `${Array.isArray(provisioning.children) ? provisioning.children.length : 0} task${Array.isArray(provisioning.children) && provisioning.children.length === 1 ? "" : "s"} verified in graph ${currentGraphRev ?? "?"}.`
        : "A verified provisioned task graph is missing.",
    },
    { id: "gate2", label: gate2.label, state: gate2.state === "accepted" ? "pass" : gate2.state === "pending" || gate2.state === "missing" ? "pending" : "fail", detail: gate2.reason ?? gate2.detail },
    {
      id: "blockers",
      label: "Start blockers",
      state: unresolvedBlockers.length === 0 ? "pass" : "fail",
      detail: unresolvedBlockers.length === 0
        ? "No unresolved dependency blocks this task."
        : `Waiting on ${unresolvedBlockers.map((blocker) => blocker.identifier ?? blocker.title).join(", ")}.`,
    },
  ];

  const completionRows = evidenceForIssue(records, input.currentIssue);
  if (input.currentIssue.id === input.rootIssue.id) {
    const nonTerminal = input.treeIssues.filter((issue) => !TERMINAL_STATUSES.has(issue.status));
    completionRows.push({
      id: "descendants:terminal",
      label: "All descendant tasks terminal",
      state: nonTerminal.length === 0 ? "pass" : "pending",
      detail: nonTerminal.length === 0
        ? "Every descendant task is done or cancelled."
        : `${nonTerminal.length} descendant task${nonTerminal.length === 1 ? " is" : "s are"} still open.`,
    });
  } else {
    const prLink = latestRecord(records, "pr_link", (record) => recordTargetsIssue(record, input.currentIssue.id));
    const check = latestRecord(records, "check_result", (record) => recordTargetsIssue(record, input.currentIssue.id));
    const qa = latestRecord(records, "qa_verdict", (record) => recordTargetsIssue(record, input.currentIssue.id));
    completionRows.push(
      {
        id: "review:pr",
        label: "Implementation handoff",
        state: prLink ? "pass" : "pending",
        detail: prLink ? "Task branch and PR evidence are recorded." : "PR evidence is missing.",
      },
      {
        id: "review:checks",
        label: "Focused checks",
        state: check ? outcomeState(check) : "pending",
        detail: check ? (outcomeState(check) === "pass" ? "Focused checks passed." : "Latest focused check did not pass.") : "Focused check evidence is missing.",
      },
      {
        id: "review:independent",
        label: "Independent review",
        state: qa ? outcomeState(qa) : "pending",
        detail: qa ? (outcomeState(qa) === "pass" ? "Independent QA passed." : "Latest QA verdict did not pass.") : "Independent QA or Board confirmation is missing.",
      },
    );
  }

  const missingCompletion = completionRows.filter((row) => row.state === "pending" || row.state === "fail");
  let decision: SdlcDecisionSummary;
  if (gate1.state === "pending" || gate2.state === "pending") {
    const pending = gate1.state === "pending" ? gate1 : gate2;
    decision = { owner: "board", state: "action", label: `Board decision needed · ${pending.label}`, detail: pending.detail };
  } else if (["rejected", "stale", "failed"].includes(gate1.state) || ["rejected", "stale", "failed"].includes(gate2.state)) {
    const stopped = ["rejected", "stale", "failed"].includes(gate1.state) ? gate1 : gate2;
    decision = { owner: "delivery", state: "blocked", label: `${stopped.label} must be resolved`, detail: stopped.reason ?? stopped.detail };
  } else if (!dorPassed) {
    decision = { owner: "delivery", state: "blocked", label: "Plan readiness evidence is required", detail: startRows[0]!.detail };
  } else if (!provisioning) {
    decision = { owner: "delivery", state: "blocked", label: "Provision and verify the task graph", detail: "Gate 2 cannot be requested until graph readback is recorded." };
  } else if (gate1.state !== "accepted" || gate2.state !== "accepted") {
    const missingGate = gate1.state !== "accepted" ? gate1 : gate2;
    decision = { owner: "delivery", state: "blocked", label: `Request ${missingGate.label}`, detail: missingGate.detail };
  } else if (unresolvedBlockers.length > 0) {
    decision = { owner: "delivery", state: "blocked", label: "Resolve the named start blockers", detail: startRows[4]!.detail };
  } else if (input.currentIssue.status === "in_review" && missingCompletion.length > 0) {
    decision = { owner: "reviewer", state: "action", label: `${missingCompletion.length} completion evidence item${missingCompletion.length === 1 ? " is" : "s are"} missing`, detail: missingCompletion.map((row) => row.label).join(", ") };
  } else {
    decision = { owner: null, state: "clear", label: "No Board decision is needed", detail: missingCompletion.length > 0 ? "Delivery can continue; completion evidence remains outstanding." : "Start and completion evidence are satisfied." };
  }

  return {
    riskClass: readString(classification, "class"),
    gate1,
    gate2,
    decision,
    startRows,
    completionRows,
    providers: providerSummaries(records),
    evidenceLinks: evidenceLinks(records),
    tasks: taskSummaries({ records, treeIssues: input.treeIssues, gate2, agentNameById: input.agentNameById ?? new Map() }),
  };
}
