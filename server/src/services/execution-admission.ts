import { and, desc, eq } from "drizzle-orm";
import { access, constants as fsConstants } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { agents, issues, projectWorkspaces } from "@paperclipai/db";
import {
  agentAdmissionProfileSchema,
  issueExecutionPolicySchema,
  type AgentAdmissionCapability,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { findActiveServerAdapter } from "../adapters/registry.js";

export type ExecutionAdmissionCheckCode =
  | "adapter_supported"
  | "model_supported"
  | "gateway_reachable"
  | "workspace_available"
  | `capability:${AgentAdmissionCapability}`
  | "profile_fresh"
  | "production_authorized";

export interface ExecutionAdmissionCheck {
  code: ExecutionAdmissionCheckCode;
  passed: boolean;
  source: "runtime" | "workspace" | "declared_profile" | "issue_policy";
  detail: string;
}

export interface ExecutionAdmissionResult {
  admitted: boolean;
  issueId: string;
  agentId: string;
  adapterType: string;
  model: string | null;
  productionMutationAuthorized: boolean;
  checks: ExecutionAdmissionCheck[];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function adapterNeedsRemoteGatewayCanary(adapterType: string) {
  return /(?:gateway|cloud|http)/i.test(adapterType);
}

function profileIsFresh(verifiedAt: string | null, maxAgeSeconds: number, now: Date) {
  if (!verifiedAt) return false;
  const timestamp = Date.parse(verifiedAt);
  return Number.isFinite(timestamp) && now.getTime() - timestamp <= maxAgeSeconds * 1_000;
}

/**
 * Fail-closed, secret-free admission check used before checkout and before a
 * queued heartbeat is promoted to running. External capabilities come only
 * from the agent's declared admission profile; this function never reads or
 * logs provider credentials.
 */
export async function evaluateExecutionAdmission(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    executionPolicy?: unknown;
    projectId?: string | null;
  },
): Promise<ExecutionAdmissionResult> {
  const [agent, issue] = await Promise.all([
    db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null),
    db.select({
      id: issues.id,
      projectId: issues.projectId,
      executionPolicy: issues.executionPolicy,
    }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null),
  ]);
  if (!agent || !issue) {
    throw new HttpError(404, !agent ? "Admission agent not found" : "Admission issue not found");
  }

  const effectiveExecutionPolicy = input.executionPolicy === undefined ? issue.executionPolicy : input.executionPolicy;
  const effectiveProjectId = input.projectId === undefined ? issue.projectId : input.projectId;
  const policy = issueExecutionPolicySchema.safeParse(effectiveExecutionPolicy).success
    ? issueExecutionPolicySchema.parse(effectiveExecutionPolicy)
    : null;
  const requirements = policy?.admission ?? null;
  const runtimeConfig = readRecord(agent.runtimeConfig);
  const parsedProfile = agentAdmissionProfileSchema.safeParse(runtimeConfig.admissionProfile);
  const profile = parsedProfile.success ? parsedProfile.data : null;
  const adapter = findActiveServerAdapter(agent.adapterType);
  const configuredModel = readString(readRecord(agent.adapterConfig).model);
  const declaredModelIds = new Set((adapter?.models ?? []).map((model) => model.id));
  const now = input.now ?? new Date();

  const workspaces = effectiveProjectId
    ? await db.select({
      id: projectWorkspaces.id,
      cwd: projectWorkspaces.cwd,
      repoUrl: projectWorkspaces.repoUrl,
      sourceType: projectWorkspaces.sourceType,
    })
      .from(projectWorkspaces)
      .where(and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, effectiveProjectId),
      ))
      .orderBy(desc(projectWorkspaces.isPrimary), desc(projectWorkspaces.updatedAt))
      .limit(1)
    : [];
  const workspace = workspaces[0] ?? null;
  const structuralWorkspaceAvailable = !effectiveProjectId || Boolean(
    workspace?.cwd?.trim() || workspace?.repoUrl?.trim(),
  );
  const localWorkspaceAccessible = structuralWorkspaceAvailable && workspace?.sourceType === "local_path" && workspace.cwd
    ? await access(workspace.cwd, fsConstants.R_OK | fsConstants.W_OK).then(() => true, () => false)
    : structuralWorkspaceAvailable;
  const checks: ExecutionAdmissionCheck[] = [];

  checks.push({
    code: "adapter_supported",
    passed: Boolean(adapter) && (
      !requirements?.allowedAdapterTypes.length || requirements.allowedAdapterTypes.includes(agent.adapterType)
    ),
    source: "runtime",
    detail: adapter ? `active adapter ${agent.adapterType}` : `adapter ${agent.adapterType} is unavailable`,
  });

  checks.push({
    code: "model_supported",
    passed: (
      !configuredModel || declaredModelIds.size === 0 || declaredModelIds.has(configuredModel)
    ) && (
      !requirements?.allowedModels.length || Boolean(configuredModel && requirements.allowedModels.includes(configuredModel))
    ),
    source: "issue_policy",
    detail: configuredModel ?? "adapter default model",
  });

  const needsRemoteGatewayCanary = adapterNeedsRemoteGatewayCanary(agent.adapterType);
  if (requirements?.requireGatewayReachable ?? true) {
    checks.push({
      code: "gateway_reachable",
      passed: Boolean(adapter) && (!needsRemoteGatewayCanary || profile?.gatewayReachable === true),
      source: needsRemoteGatewayCanary ? "declared_profile" : "runtime",
      detail: needsRemoteGatewayCanary ? "remote gateway canary" : "local adapter runtime",
    });
  }

  if (requirements?.requireWorkspaceAvailable ?? true) {
    checks.push({
      code: "workspace_available",
      passed: localWorkspaceAccessible && (profile?.workspaceAvailable !== false),
      source: "workspace",
      detail: localWorkspaceAccessible ? "project workspace canary passed" : "project workspace is unavailable",
    });
  }

  for (const capability of requirements?.requiredCapabilities ?? []) {
    const capabilityGranted = profile?.capabilities[capability] === true;
    checks.push({
      code: `capability:${capability}`,
      passed: capabilityGranted,
      source: "declared_profile",
      detail: capabilityGranted ? "declared available" : "not declared available",
    });
  }

  const usesDeclaredCanary = needsRemoteGatewayCanary || Boolean(requirements?.requiredCapabilities.length);
  if (usesDeclaredCanary) {
    checks.push({
      code: "profile_fresh",
      passed: profileIsFresh(profile?.verifiedAt ?? null, requirements?.maxProfileAgeSeconds ?? 900, now),
      source: "declared_profile",
      detail: profile?.verifiedAt ? `verified ${profile.verifiedAt}` : "profile has no verification timestamp",
    });
  }

  const productionAuthorized = profile?.productionProviderMutationAuthorized === true;
  checks.push({
    code: "production_authorized",
    passed: requirements?.productionProviderMutation ? productionAuthorized : true,
    source: "issue_policy",
    detail: requirements?.productionProviderMutation
      ? (productionAuthorized ? "explicitly authorized" : "explicit authorization missing")
      : "production provider mutation prohibited by default",
  });

  return {
    admitted: checks.every((check) => check.passed),
    issueId: issue.id,
    agentId: agent.id,
    adapterType: agent.adapterType,
    model: configuredModel,
    productionMutationAuthorized: requirements?.productionProviderMutation === true && productionAuthorized,
    checks,
  };
}

export async function assertExecutionAdmission(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    executionPolicy?: unknown;
    projectId?: string | null;
  },
) {
  const result = await evaluateExecutionAdmission(db, input);
  if (result.admitted) return result;
  throw new HttpError(422, "Execution admission failed", {
    code: "execution_admission_failed",
    admission: result,
  });
}
