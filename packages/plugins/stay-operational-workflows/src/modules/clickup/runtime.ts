import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  INTEGRATION_RECONCILIATION_DOCUMENT_KEY,
  validateLiveIssueDag,
  type Agent,
  type IntegrationReconciliationReceipt,
  type Issue,
  type IssueDocument,
  type IssueThreadInteraction,
} from "@paperclipai/shared";
import { isClickUpActiveConfig, sha256, type AuditIdentity, type ModuleConfig } from "../../contracts.js";
import type { WorkflowRepository } from "../../repository.js";
import { assertClickUpModuleActivationUsable, ClickUpConfigurationError } from "./config.js";
import { acceptedClickUpDeliveryMetadata } from "./metadata.js";
import { ClickUpApiClient } from "./provider.js";
import { clickUpCorrelationValue } from "./identity.js";
import { renderClickUpShadowProjection } from "./projection.js";
import { reconcileClickUpRelationships } from "./relationships.js";
import { projectIssueToClickUp, type ClickUpProjectionReceipt } from "./sync.js";
import type {
  ClickUpApiPort,
  ClickUpModuleActivation,
  ClickUpProjectionSource,
  ClickUpTaskLink,
} from "./types.js";
import { PostgresClickUpRepository } from "./repository.js";

export interface ClickUpReconcileResult {
  companyId: string;
  configuredProjects: number;
  scanned: number;
  created: number;
  updated: number;
  alreadyCurrent: number;
  relationshipsUpdated: number;
  reconciliationReceiptsUpdated: number;
  conflicts: number;
  retryableFailures: number;
  terminalFailures: number;
  externalWrites: number;
}

type ClientFactory = (activation: ClickUpModuleActivation, token: string) => ClickUpApiPort;

function compactText(value: string | null, fallback: string, max = 4_000): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, max);
}

function acceptanceSummary(issue: Issue): string {
  const description = issue.description ?? "";
  const match = description.match(/(?:^|\n)#{1,4}\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n#{1,4}\s|$)/i);
  return compactText(match?.[1] ?? null, `Mirror ${issue.identifier ?? issue.id} with Paperclip-authoritative state.`, 2_000);
}

function issueUrl(base: string, issue: Issue): string {
  return new URL(`issues/${encodeURIComponent(issue.identifier ?? issue.id)}`, base.endsWith("/") ? base : `${base}/`).toString();
}

function blockerSummary(issue: Issue, blockers: Array<{ identifier: string | null; id: string; title: string }>): string | null {
  if (blockers.length === 0) return issue.status === "blocked" ? "Blocked in Paperclip; no explicit blocker relation is currently readable." : null;
  return `Blocked by ${blockers.map((blocker) => `${blocker.identifier ?? blocker.id}: ${blocker.title}`).join("; ")}`.slice(0, 2_000);
}

function sortParentsFirst(issues: Issue[]): Issue[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (issue: Issue): number => {
    const known = depths.get(issue.id);
    if (known != null) return known;
    if (visiting.has(issue.id)) throw new ClickUpConfigurationError("clickup_parent_cycle_detected");
    visiting.add(issue.id);
    const parent = issue.parentId ? byId.get(issue.parentId) : null;
    const value = parent ? depth(parent) + 1 : 0;
    visiting.delete(issue.id);
    depths.set(issue.id, value);
    return value;
  };
  return [...issues].sort((left, right) => depth(left) - depth(right)
    || left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id));
}

export function isClickUpParentReconciliationReady(
  parent: Pick<Issue, "id">,
  children: ReadonlyArray<Pick<Issue, "id" | "status">>,
  projectionHealthyIssueIds: ReadonlySet<string>,
  relationshipHealthyIssueIds: ReadonlySet<string>,
): boolean {
  return projectionHealthyIssueIds.has(parent.id)
    && relationshipHealthyIssueIds.has(parent.id)
    && children.length > 0 && children.every((child) =>
    ["done", "cancelled"].includes(child.status)
    && projectionHealthyIssueIds.has(child.id)
    && relationshipHealthyIssueIds.has(child.id));
}

export class ClickUpReconciliationService {
  private readonly links: PostgresClickUpRepository;
  private readonly inFlightCompanies = new Set<string>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly workflows: WorkflowRepository,
    private readonly clientFactory: ClientFactory = (activation, token) => new ClickUpApiClient(ctx.http, activation.destination, token),
  ) {
    this.links = new PostgresClickUpRepository(ctx.db);
  }

  async reconcileCompany(companyId: string, audit: AuditIdentity): Promise<ClickUpReconcileResult> {
    const result: ClickUpReconcileResult = {
      companyId,
      configuredProjects: 0,
      scanned: 0,
      created: 0,
      updated: 0,
      alreadyCurrent: 0,
      relationshipsUpdated: 0,
      reconciliationReceiptsUpdated: 0,
      conflicts: 0,
      retryableFailures: 0,
      terminalFailures: 0,
      externalWrites: 0,
    };
    if (this.inFlightCompanies.has(companyId)) return result;
    this.inFlightCompanies.add(companyId);
    try {
      const configs = (await this.workflows.listConfigs(companyId, true)).filter(isClickUpActiveConfig);
      result.configuredProjects = configs.length;
      for (const config of configs) await this.reconcileProject(config, audit, result);
      return result;
    } finally {
      this.inFlightCompanies.delete(companyId);
    }
  }

  private async reconcileProject(
    config: ModuleConfig,
    audit: AuditIdentity,
    result: ClickUpReconcileResult,
  ): Promise<void> {
    const activation = config.clickUpActivation!;
    try {
      assertClickUpModuleActivationUsable(activation);
      const token = await this.ctx.secrets.resolve(activation.tokenRef, {
        companyId: config.companyId,
        configPath: "clickup.tokenRef",
      });
      const api = this.clientFactory(activation, token);
      const issues = sortParentsFirst(await this.listProjectIssues(config));
      const issueIds = new Set(issues.map((issue) => issue.id));
      const relations = new Map<string, Awaited<ReturnType<PluginContext["issues"]["relations"]["get"]>>>();
      const agents = new Map<string, Agent | null>();
      const links = new Map<string, ClickUpTaskLink>();
      const planContexts = new Map<string, { planDocument: IssueDocument | null; interactions: IssueThreadInteraction[] }>();

      const projectionReceipts = new Map<string, ClickUpProjectionReceipt>();
      const relationshipHealthy = new Set<string>();
      const failureClasses = new Map<string, string>();

      await Promise.all(issues.map(async (issue) => {
        relations.set(issue.id, await this.ctx.issues.relations.get(issue.id, config.companyId));
      }));
      const dagFindings = validateLiveIssueDag(issues.map((issue) => ({
        id: issue.id,
        parentId: issue.parentId,
        status: issue.status,
        blockedByIssueIds: (relations.get(issue.id)?.blockedBy ?? []).map((blocker) => blocker.id),
      })));
      if (dagFindings.length > 0) {
        await this.recordException(
          config,
          audit,
          null,
          "clickup_live_dag_invalid",
          `Provider writes stopped: ${dagFindings.map((finding) => `${finding.code}:${finding.issueId}`).join(", ")}`,
        );
        result.terminalFailures += 1;
        return;
      }
      for (const issue of issues) {
        result.scanned += 1;
        let planDocument: IssueDocument | null = null;
        let interactions: IssueThreadInteraction[] = [];
        if (issue.parentId) {
          let context = planContexts.get(issue.parentId);
          if (!context) {
            const [parentPlan, parentInteractions] = await Promise.all([
              this.ctx.issues.documents.get(issue.parentId, "plan", config.companyId),
              this.ctx.issues.listInteractions(issue.parentId, config.companyId),
            ]);
            context = { planDocument: parentPlan, interactions: parentInteractions };
            planContexts.set(issue.parentId, context);
          }
          planDocument = context.planDocument;
          interactions = context.interactions;
        }
        const deliveryMetadata = acceptedClickUpDeliveryMetadata({ issue, planDocument, interactions });
        if (!deliveryMetadata.approvedEstimate || !deliveryMetadata.dueDate) {
          await this.recordException(config, audit, issue.id, "clickup_planning_metadata_invalid", "Approved estimate, due date, or forecast revision metadata is absent or malformed; this mirror stayed fail-closed.");
          result.terminalFailures += 1;
          failureClasses.set(issue.id, "clickup_planning_metadata_invalid");
          continue;
        }

        let assignee: Agent | null = null;
        const relation = relations.get(issue.id)!;
        if (issue.assigneeAgentId) {
          if (!agents.has(issue.assigneeAgentId)) {
            agents.set(issue.assigneeAgentId, await this.ctx.agents.get(issue.assigneeAgentId, config.companyId));
          }
          assignee = agents.get(issue.assigneeAgentId) ?? null;
        }
        const desiredParentTaskId = issue.parentId ? links.get(issue.parentId)?.taskId ?? null : null;
        if (issue.parentId && issueIds.has(issue.parentId) && !desiredParentTaskId) {
          await this.recordException(config, audit, issue.id, "clickup_parent_mapping_pending", "Parent mirror is not yet available; child create stayed fail-closed.");
          result.retryableFailures += 1;
          failureClasses.set(issue.id, "clickup_parent_mapping_pending");
          continue;
        }

        const source: ClickUpProjectionSource = {
          companyId: config.companyId,
          projectId: config.projectId,
          issueId: issue.id,
          issueIdentifier: issue.identifier ?? issue.id,
          issueUrl: issueUrl(activation.paperclipBaseUrl, issue),
          title: issue.title,
          planningSummary: compactText(issue.description, issue.title),
          status: issue.status,
          assigneeDisplayRef: deliveryMetadata.plannedOwner ?? (assignee ? (assignee.title ?? assignee.name) : issue.assigneeUserId ? "Board owner" : null),
          blockerSummary: blockerSummary(issue, relation.blockedBy),
          acceptanceSummary: acceptanceSummary(issue),
          approvedEstimate: deliveryMetadata.approvedEstimate,
          dueDate: deliveryMetadata.dueDate,
          updatedAt: issue.updatedAt.toISOString(),
        };
        const projection = renderClickUpShadowProjection({
          source,
          config: activation.destination,
          policyVersion: config.policyVersion,
          parentTaskId: desiredParentTaskId,
        });
        const receipt = await projectIssueToClickUp({
          projection,
          config: activation.destination,
          authorization: activation.authorization,
          api,
          repository: this.links,
        });
        this.countReceipt(receipt, result);
        projectionReceipts.set(issue.id, receipt);
        const stored = await this.links.getByIssue(config.companyId, issue.id);
        if (stored) links.set(issue.id, stored);
        if (receipt.outcome !== "succeeded") {
          await this.recordException(config, audit, issue.id, receipt.errorClass ?? "clickup_projection_failed", receipt.outcome);
          failureClasses.set(issue.id, receipt.errorClass ?? "clickup_projection_failed");
        }
      }

      for (const issue of issues) {
        const link = links.get(issue.id);
        if (!link) continue;
        const relation = relations.get(issue.id)!;
        const desiredParentTaskId = issue.parentId ? links.get(issue.parentId)?.taskId ?? null : null;
        const missingParent = Boolean(issue.parentId && !desiredParentTaskId);
        const desiredDependencyTaskIds: string[] = [];
        const missingBlockers: string[] = [];
        for (const blocker of relation.blockedBy) {
          const taskId = links.get(blocker.id)?.taskId;
          if (taskId) desiredDependencyTaskIds.push(taskId);
          else missingBlockers.push(blocker.identifier ?? blocker.id);
        }
        if (missingParent || missingBlockers.length > 0) {
          await this.recordException(
            config,
            audit,
            issue.id,
            "clickup_relationship_mapping_incomplete",
            `Missing mapped ${missingParent ? "parent" : ""}${missingParent && missingBlockers.length ? " and " : ""}${missingBlockers.length ? "blocker" : ""} task identities.`,
          );
          result.retryableFailures += 1;
          failureClasses.set(issue.id, "clickup_relationship_mapping_incomplete");
          continue;
        }
        try {
          const relationship = await reconcileClickUpRelationships({
            api,
            config: activation.destination,
            taskId: link.taskId,
            correlationValue: clickUpCorrelationValue(issue.id, issueUrl(activation.paperclipBaseUrl, issue)),
            desiredParentTaskId,
            desiredDependencyTaskIds,
            managedDependencyTaskIds: [...links.values()].map((candidate) => candidate.taskId),
          });
          relationshipHealthy.add(issue.id);
          if (relationship.action === "updated") {
            result.relationshipsUpdated += 1;
            result.externalWrites += relationship.writes;
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "clickup_relationship_failed";
          await this.recordException(config, audit, issue.id, code, "Relationship drift could not be repaired; Paperclip remained unchanged.");
          result.conflicts += 1;
          failureClasses.set(issue.id, code);
        }
      }
      result.reconciliationReceiptsUpdated += await this.persistReconciliationReceipts({
        config,
        issues,
        projectionReceipts,
        relationshipHealthy,
        failureClasses,
      });
      await this.wakeReconciledParents(config, issues, projectionReceipts, relationshipHealthy);
    } catch (error) {
      const code = error instanceof Error ? error.message : "clickup_reconciliation_failed";
      await this.recordException(config, audit, null, code, "ClickUp reconciliation failed closed before Paperclip authority changed.");
      result.terminalFailures += 1;
    }
  }

  private async persistReconciliationReceipts(input: {
    config: ModuleConfig;
    issues: Issue[];
    projectionReceipts: Map<string, ClickUpProjectionReceipt>;
    relationshipHealthy: Set<string>;
    failureClasses: Map<string, string>;
  }): Promise<number> {
    let writes = 0;
    for (const issue of input.issues) {
      const projection = input.projectionReceipts.get(issue.id);
      const projectionHealthy = projection?.outcome === "succeeded";
      const relationshipsHealthy = input.relationshipHealthy.has(issue.id);
      const status: IntegrationReconciliationReceipt["integrations"][string]["status"] =
        projectionHealthy && relationshipsHealthy
          ? "healthy"
          : projection?.outcome === "conflict"
            ? "conflict"
            : projection?.outcome === "terminal_failure" || input.failureClasses.get(issue.id) === "clickup_planning_metadata_invalid"
              ? "terminal_failure"
              : "retryable_failure";
      const receipt: IntegrationReconciliationReceipt = {
        schemaVersion: 1,
        issueId: issue.id,
        source: {
          status: issue.status,
          updatedAt: issue.updatedAt.toISOString(),
        },
        requiredIntegrations: ["clickup"],
        integrations: {
          clickup: {
            status,
            projectionVersion: projection?.projectionVersion ?? null,
            taskId: projection?.taskId ?? null,
            projectionHealthy,
            relationshipsHealthy,
            errorClass: input.failureClasses.get(issue.id) ?? null,
          },
        },
      };
      const body = `${JSON.stringify(receipt, null, 2)}\n`;
      const existing = await this.ctx.issues.documents.get(
        issue.id,
        INTEGRATION_RECONCILIATION_DOCUMENT_KEY,
        input.config.companyId,
      );
      if (existing?.body === body) continue;
      await this.ctx.issues.documents.upsert({
        issueId: issue.id,
        key: INTEGRATION_RECONCILIATION_DOCUMENT_KEY,
        companyId: input.config.companyId,
        title: "Required integration reconciliation",
        format: "json",
        body,
        changeSummary: "Record current ClickUp projection and relationship readback health",
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
      writes += 1;
    }
    return writes;
  }

  private async wakeReconciledParents(
    config: ModuleConfig,
    issues: Issue[],
    projectionReceipts: Map<string, ClickUpProjectionReceipt>,
    relationshipHealthy: Set<string>,
  ): Promise<void> {
    for (const parent of issues) {
      if (
        !parent.assigneeAgentId
        || ["backlog", "done", "cancelled"].includes(parent.status)
      ) continue;
      const children = issues.filter((issue) => issue.parentId === parent.id);
      if (children.length === 0) continue;
      const ready = isClickUpParentReconciliationReady(
        parent,
        children,
        new Set([...projectionReceipts.entries()]
          .filter(([, receipt]) => receipt.outcome === "succeeded")
          .map(([issueId]) => issueId)),
        relationshipHealthy,
      );
      if (!ready) continue;
      const signature = [parent, ...children]
        .map((child) => [
          child.id,
          child.status,
          child.updatedAt.toISOString(),
          projectionReceipts.get(child.id)?.projectionVersion ?? "missing",
        ].join(":"))
        .sort()
        .join("|");
      await this.ctx.issues.requestWakeup(parent.id, config.companyId, {
        reason: "children_and_required_integrations_reconciled",
        contextSource: "stay-operational-workflows.clickup",
        idempotencyKey: `clickup-parent-ready:${parent.id}:${sha256(signature)}`,
      });
    }
  }
  private async listProjectIssues(config: ModuleConfig): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.ctx.issues.list({
        companyId: config.companyId,
        projectId: config.projectId,
        includePluginOperations: false,
        limit: 100,
        offset,
      });
      issues.push(...page);
      if (page.length < 100) break;
    }
    return issues;
  }

  private countReceipt(receipt: ClickUpProjectionReceipt, result: ClickUpReconcileResult): void {
    if (receipt.action === "created") result.created += 1;
    else if (receipt.action === "updated") result.updated += 1;
    else if (receipt.action === "already_current") result.alreadyCurrent += 1;
    else if (receipt.action === "conflict") result.conflicts += 1;
    if (receipt.outcome === "retryable_failure") result.retryableFailures += 1;
    if (receipt.outcome === "terminal_failure") result.terminalFailures += 1;
    if (receipt.action === "created" || receipt.action === "updated") result.externalWrites += 1;
  }

  private async recordException(
    config: ModuleConfig,
    audit: AuditIdentity,
    issueId: string | null,
    kind: string,
    summary: string,
  ): Promise<void> {
    await this.workflows.createException({
      companyId: config.companyId,
      projectId: config.projectId,
      module: "clickup",
      operationId: null,
      exceptionKey: sha256([config.companyId, config.projectId, "clickup", issueId ?? "config", kind].join("\u001f")),
      kind: kind.slice(0, 120),
      summary: summary.slice(0, 500),
      attempt: 0,
      audit,
    });
  }
}
