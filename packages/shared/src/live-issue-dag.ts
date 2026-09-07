export const INTEGRATION_RECONCILIATION_DOCUMENT_KEY = "integration-reconciliation";

export type IntegrationReconciliationStatus = "healthy" | "retryable_failure" | "terminal_failure" | "conflict";

export type IntegrationReconciliationReceipt = {
  schemaVersion: 1;
  issueId: string;
  source: { status: string; updatedAt: string };
  requiredIntegrations: string[];
  integrations: Record<string, {
    status: IntegrationReconciliationStatus;
    projectionVersion: string | null;
    taskId: string | null;
    projectionHealthy: boolean;
    relationshipsHealthy: boolean;
    errorClass: string | null;
  }>;
};

export function parseIntegrationReconciliationReceipt(value: string | null | undefined): IntegrationReconciliationReceipt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<IntegrationReconciliationReceipt>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.issueId !== "string"
      || !parsed.source
      || typeof parsed.source.status !== "string"
      || typeof parsed.source.updatedAt !== "string"
      || !Array.isArray(parsed.requiredIntegrations)
      || !parsed.requiredIntegrations.every((item) => typeof item === "string" && item.length > 0)
      || !parsed.integrations
      || typeof parsed.integrations !== "object"
    ) return null;
    return parsed as IntegrationReconciliationReceipt;
  } catch {
    return null;
  }
}

export function isIntegrationReceiptCurrentAndHealthy(input: {
  receipt: IntegrationReconciliationReceipt | null;
  issueId: string;
  status: string;
  updatedAt: string;
  requiredIntegrations: string[];
}): boolean {
  const { receipt } = input;
  if (!receipt
    || receipt.issueId !== input.issueId
    || receipt.source.status !== input.status
    || receipt.source.updatedAt !== input.updatedAt) return false;
  return input.requiredIntegrations.every((integration) => {
    const state = receipt.integrations[integration];
    return state?.status === "healthy" && state.projectionHealthy === true && state.relationshipsHealthy === true;
  });
}

export type LiveIssueDagNode = {
  id: string;
  parentId: string | null;
  status: string;
  blockedByIssueIds: string[];
  requiredIntegrations?: string[];
  healthyIntegrations?: string[];
};

export type LiveIssueDagFindingCode =
  | "missing_parent"
  | "missing_blocker"
  | "hierarchy_cycle"
  | "dependency_cycle"
  | "blocked_without_live_blocker"
  | "stale_root_blocker"
  | "premature_parent_completion"
  | "impossible_hierarchy_dependency"
  | "terminal_integration_pending";

export type LiveIssueDagFinding = { code: LiveIssueDagFindingCode; issueId: string; relatedIssueIds: string[] };

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

/** Validates the live wait graph without mutating issues or provider state. */
export function validateLiveIssueDag(nodes: LiveIssueDagNode[]): LiveIssueDagFinding[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const findings: LiveIssueDagFinding[] = [];
  const add = (code: LiveIssueDagFindingCode, issueId: string, relatedIssueIds: string[] = []) => {
    findings.push({ code, issueId, relatedIssueIds: [...new Set(relatedIssueIds)].sort() });
  };

  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) add("missing_parent", node.id, [node.parentId]);
    const missingBlockers = node.blockedByIssueIds.filter((id) => !byId.has(id));
    if (missingBlockers.length > 0) add("missing_blocker", node.id, missingBlockers);
    const liveBlockers = node.blockedByIssueIds.filter((id) => {
      const blocker = byId.get(id);
      return blocker && !TERMINAL_STATUSES.has(blocker.status);
    });
    if (node.status === "blocked" && liveBlockers.length === 0) {
      add(node.parentId === null ? "stale_root_blocker" : "blocked_without_live_blocker", node.id, node.blockedByIssueIds);
    }
    if (TERMINAL_STATUSES.has(node.status)) {
      const missing = (node.requiredIntegrations ?? []).filter(
        (integration) => !(node.healthyIntegrations ?? []).includes(integration),
      );
      if (missing.length > 0) add("terminal_integration_pending", node.id, missing);
    }
  }

  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  for (const node of nodes) {
    const incomplete = (children.get(node.id) ?? []).filter((id) => !TERMINAL_STATUSES.has(byId.get(id)!.status));
    if (node.status === "done" && incomplete.length > 0) add("premature_parent_completion", node.id, incomplete);
  }

  const findCycles = (edges: (node: LiveIssueDagNode) => string[], code: "hierarchy_cycle" | "dependency_cycle") => {
    for (const start of nodes) {
      const visited = new Set<string>();
      const stack = new Set<string>();
      const walk = (id: string): boolean => {
        if (stack.has(id)) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        stack.add(id);
        for (const next of edges(byId.get(id)!)) {
          if (byId.has(next) && walk(next)) return true;
        }
        stack.delete(id);
        return false;
      };
      if (walk(start.id)) add(code, start.id);
    }
  };
  findCycles((node) => node.parentId ? [node.parentId] : [], "hierarchy_cycle");
  findCycles((node) => node.blockedByIssueIds, "dependency_cycle");

  const ancestorsOf = (id: string): Set<string> => {
    const ancestors = new Set<string>();
    let parentId = byId.get(id)?.parentId ?? null;
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return ancestors;
  };
  for (const node of nodes) {
    const ancestors = ancestorsOf(node.id);
    const impossible = node.blockedByIssueIds.filter((blockerId) => ancestors.has(blockerId));
    if (impossible.length > 0) add("impossible_hierarchy_dependency", node.id, impossible);
  }

  return findings.sort((left, right) =>
    left.issueId.localeCompare(right.issueId) || left.code.localeCompare(right.code));
}
export class LiveIssueDagValidationError extends Error {
  constructor(public readonly findings: LiveIssueDagFinding[]) {
    super("live_issue_dag_invalid");
    this.name = "LiveIssueDagValidationError";
  }
}

export function assertLiveIssueDag(nodes: LiveIssueDagNode[]): void {
  const findings = validateLiveIssueDag(nodes);
  if (findings.length > 0) throw new LiveIssueDagValidationError(findings);
}
