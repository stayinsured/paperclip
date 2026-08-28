import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Agent, Issue } from "@paperclipai/shared";
import { isClickUpActiveConfig, sha256, type AuditIdentity, type ModuleConfig } from "../../contracts.js";
import type { WorkflowRepository } from "../../repository.js";
import { assertClickUpModuleActivationUsable, ClickUpConfigurationError } from "./config.js";
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
      const relations = new Map<string, Awaited<ReturnType<PluginContext["issues"]["relations"]["get"]>>>();
      const agents = new Map<string, Agent | null>();
      const links = new Map<string, ClickUpTaskLink>();

      for (const issue of issues) {
        result.scanned += 1;
        const relation = await this.ctx.issues.relations.get(issue.id, config.companyId);
        relations.set(issue.id, relation);
        let assignee: Agent | null = null;
        if (issue.assigneeAgentId) {
          if (!agents.has(issue.assigneeAgentId)) {
            agents.set(issue.assigneeAgentId, await this.ctx.agents.get(issue.assigneeAgentId, config.companyId));
          }
          assignee = agents.get(issue.assigneeAgentId) ?? null;
        }
        const existing = await this.links.getByIssue(config.companyId, issue.id);
        const source: ClickUpProjectionSource = {
          companyId: config.companyId,
          projectId: config.projectId,
          issueId: issue.id,
          issueIdentifier: issue.identifier ?? issue.id,
          issueUrl: issueUrl(activation.paperclipBaseUrl, issue),
          title: issue.title,
          planningSummary: compactText(issue.description, issue.title),
          status: issue.status,
          assigneeDisplayRef: assignee ? (assignee.title ?? assignee.name) : issue.assigneeUserId ? "Board owner" : null,
          blockerSummary: blockerSummary(issue, relation.blockedBy),
          acceptanceSummary: acceptanceSummary(issue),
          approvedEstimate: null,
          updatedAt: issue.updatedAt.toISOString(),
        };
        const projection = renderClickUpShadowProjection({
          source,
          config: activation.destination,
          policyVersion: config.policyVersion,
          previousProjectedStatusId: String(existing?.baseSnapshot.status ?? activation.destination.statuses.toDo.id),
        });
        const receipt = await projectIssueToClickUp({
          projection,
          config: activation.destination,
          authorization: activation.authorization,
          api,
          repository: this.links,
        });
        this.countReceipt(receipt, result);
        const stored = await this.links.getByIssue(config.companyId, issue.id);
        if (stored) links.set(issue.id, stored);
        if (receipt.outcome !== "succeeded") {
          await this.recordException(config, audit, issue.id, receipt.errorClass ?? "clickup_projection_failed", receipt.outcome);
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
          });
          if (relationship.action === "updated") {
            result.relationshipsUpdated += 1;
            result.externalWrites += relationship.writes;
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "clickup_relationship_failed";
          await this.recordException(config, audit, issue.id, code, "Relationship drift could not be repaired; Paperclip remained unchanged.");
          result.conflicts += 1;
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "clickup_reconciliation_failed";
      await this.recordException(config, audit, null, code, "ClickUp reconciliation failed closed before Paperclip authority changed.");
      result.terminalFailures += 1;
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
