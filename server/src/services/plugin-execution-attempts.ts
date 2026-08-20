import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySkills,
  companySkillVersions,
  pluginExecutionAttempts,
  pluginManagedResources,
} from "@paperclipai/db";
import type { AdapterExecutionProfile } from "@paperclipai/adapter-utils";
import type {
  PaperclipPluginManifestV1,
  PluginExecutionAgentKeyScope,
} from "@paperclipai/shared";
import type { PluginExecutionAttempt, PluginExecutionInvocation } from "@paperclipai/plugin-sdk";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { logActivity } from "./activity-log.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { validateInstanceConfig } from "./plugin-config-validator.js";

export const PLUGIN_EXECUTION_RUNTIME_MS = 120_000;
export const PLUGIN_EXECUTION_CALLBACK_MS = 5 * 60_000;
export const PLUGIN_EXECUTION_MAX_ENVELOPE_BYTES = 64 * 1024;
export const PLUGIN_EXECUTION_MAX_CALLBACK_BYTES = 64 * 1024;

const TERMINAL = ["succeeded", "failed", "cancelled", "reclaimed", "timed_out"] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
}

export function pluginExecutionDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

export function pluginExecutionSkillContentDigest(
  files: Array<{ path: string; content: string }>,
): string {
  return pluginExecutionDigest([...files].sort((left, right) => left.path.localeCompare(right.path)));
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function publicAttempt(row: typeof pluginExecutionAttempts.$inferSelect): PluginExecutionAttempt {
  return {
    id: row.id,
    companyId: row.companyId,
    pluginId: row.pluginId,
    principalAgentId: row.principalAgentId,
    heartbeatRunId: row.heartbeatRunId,
    companySkillId: row.companySkillId,
    companySkillVersionId: row.companySkillVersionId,
    skillRevisionNumber: row.skillRevisionNumber,
    skillContentDigest: row.skillContentDigest,
    allowedTool: row.allowedTool,
    status: (row.status === "callback_pending" ? "running" : row.status) as PluginExecutionAttempt["status"],
    terminalReason: row.terminalReason,
    runtimeExpiresAt: row.runtimeExpiresAt.toISOString(),
    callbackExpiresAt: row.callbackExpiresAt.toISOString(),
    billingCode: row.billingCode,
  };
}

function sameScope(row: typeof pluginExecutionAttempts.$inferSelect, scope: PluginExecutionAgentKeyScope): boolean {
  return row.companyId === scope.companyId
    && row.pluginId === scope.pluginId
    && row.pluginKey === scope.pluginKey
    && row.principalAgentId === scope.principalAgentId
    && row.id === scope.attemptId
    && row.assessmentId === scope.assessmentId
    && row.sourceKind === scope.sourceKind
    && row.sourceId === scope.sourceId
    && row.policyId === scope.policyId
    && row.policyVersion === scope.policyVersion
    && row.companySkillId === scope.skillId
    && row.companySkillVersionId === scope.skillVersionId
    && row.skillRevisionNumber === scope.skillRevisionNumber
    && row.skillContentDigest === scope.skillContentDigest
    && row.allowedTool === scope.tool
    && row.nonceDigest === scope.nonceDigest
    && row.heartbeatRunId === scope.heartbeatRunId
    && row.billingCode === scope.billingCode
    && row.callbackExpiresAt.toISOString() === scope.expiresAt;
}

export function pluginExecutionAttemptService(db: Db) {
  async function audit(row: typeof pluginExecutionAttempts.$inferSelect, action: string, details: Record<string, unknown> = {}) {
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: row.pluginId,
      action,
      entityType: "plugin_execution_attempt",
      entityId: row.id,
      agentId: row.principalAgentId,
      runId: row.heartbeatRunId,
      details: {
        pluginKey: row.pluginKey,
        assessmentId: row.assessmentId,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        policyId: row.policyId,
        policyVersion: row.policyVersion,
        skillId: row.companySkillId,
        skillVersionId: row.companySkillVersionId,
        skillContentDigest: row.skillContentDigest,
        tool: row.allowedTool,
        ...details,
      },
    });
  }

  async function getRow(attemptId: string) {
    return db.select().from(pluginExecutionAttempts).where(eq(pluginExecutionAttempts.id, attemptId)).then((rows) => rows[0] ?? null);
  }

  async function currentPin(row: typeof pluginExecutionAttempts.$inferSelect) {
    const skill = await db.select().from(companySkills).where(and(eq(companySkills.id, row.companySkillId), eq(companySkills.companyId, row.companyId))).then((rows) => rows[0] ?? null);
    const version = await db.select().from(companySkillVersions).where(and(eq(companySkillVersions.id, row.companySkillVersionId), eq(companySkillVersions.companySkillId, row.companySkillId), eq(companySkillVersions.companyId, row.companyId))).then((rows) => rows[0] ?? null);
    const digest = version ? pluginExecutionSkillContentDigest(version.fileInventory) : null;
    return { skill, version, valid: Boolean(skill && version && skill.currentVersionId === version.id && version.revisionNumber === row.skillRevisionNumber && digest === row.skillContentDigest) };
  }

  async function invoke(input: PluginExecutionInvocation, owner: { pluginId: string; pluginKey: string; manifest: PaperclipPluginManifestV1 }): Promise<typeof pluginExecutionAttempts.$inferSelect> {
    const requiredIdentities = [
      input.principalAgentKey,
      input.coordinatorAttemptId,
      input.assessmentId,
      input.source.kind,
      input.source.id,
      input.policy.id,
      input.policy.version,
      input.nonce,
      input.billingCode,
    ];
    if (requiredIdentities.some((value) => !value.trim())) {
      throw badRequest("Restricted execution identities, source, policy, nonce, and billingCode are required");
    }
    if (byteLength(input.envelope) > PLUGIN_EXECUTION_MAX_ENVELOPE_BYTES) throw unprocessable("Restricted execution envelope exceeds 64 KiB");
    if (!input.envelope || typeof input.envelope !== "object" || Array.isArray(input.envelope)) {
      throw badRequest("Restricted execution envelope must be an object");
    }
    const declaration = owner.manifest.agents?.find((candidate) => candidate.agentKey === input.principalAgentKey);
    const principal = declaration?.executionPrincipal;
    if (!declaration || principal?.kind !== "plugin_tool_only") throw forbidden("Managed agent is not a plugin_tool_only execution principal");
    const bindings = await db.select().from(pluginManagedResources).where(and(eq(pluginManagedResources.companyId, input.companyId), eq(pluginManagedResources.pluginId, owner.pluginId), inArray(pluginManagedResources.resourceKind, ["agent", "skill"])));
    const agentBinding = bindings.find((binding) => binding.resourceKind === "agent" && binding.resourceKey === declaration.agentKey);
    const skillBinding = bindings.find((binding) => binding.resourceKind === "skill" && binding.resourceKey === principal.skillKey);
    if (!agentBinding || !skillBinding) throw conflict("Restricted execution principal and skill must be reconciled before invocation");
    const [agent, skill] = await Promise.all([
      db.select().from(agents).where(and(eq(agents.id, agentBinding.resourceId), eq(agents.companyId, input.companyId))).then((rows) => rows[0] ?? null),
      db.select().from(companySkills).where(and(eq(companySkills.id, skillBinding.resourceId), eq(companySkills.companyId, input.companyId))).then((rows) => rows[0] ?? null),
    ]);
    if (!agent || !skill?.currentVersionId) throw conflict("Restricted execution managed resources are unavailable");
    if (agent.adapterType !== "codex_local") throw unprocessable("Adapter does not support plugin_execution_tool_only", { adapterType: agent.adapterType });
    const version = await db.select().from(companySkillVersions).where(and(eq(companySkillVersions.id, skill.currentVersionId), eq(companySkillVersions.companySkillId, skill.id), eq(companySkillVersions.companyId, input.companyId))).then((rows) => rows[0] ?? null);
    if (!version) throw conflict("Managed skill current version is unavailable");
    const now = Date.now();
    const inserted = await db.insert(pluginExecutionAttempts).values({
      companyId: input.companyId,
      pluginId: owner.pluginId,
      pluginKey: owner.pluginKey,
      principalAgentId: agent.id,
      companySkillId: skill.id,
      companySkillVersionId: version.id,
      skillRevisionNumber: version.revisionNumber,
      assessmentId: input.assessmentId,
      coordinatorAttemptId: input.coordinatorAttemptId,
      sourceKind: input.source.kind,
      sourceId: input.source.id,
      policyId: input.policy.id,
      policyVersion: input.policy.version,
      skillContentDigest: pluginExecutionSkillContentDigest(version.fileInventory),
      nonceDigest: pluginExecutionDigest(input.nonce),
      allowedTool: principal.tool,
      runtimeExpiresAt: new Date(now + PLUGIN_EXECUTION_RUNTIME_MS),
      callbackExpiresAt: new Date(now + PLUGIN_EXECUTION_CALLBACK_MS),
      billingCode: input.billingCode,
      sanitizedEnvelope: input.envelope,
    }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
    const row = inserted ?? await db.select().from(pluginExecutionAttempts).where(and(eq(pluginExecutionAttempts.companyId, input.companyId), eq(pluginExecutionAttempts.pluginId, owner.pluginId), eq(pluginExecutionAttempts.coordinatorAttemptId, input.coordinatorAttemptId))).then((rows) => rows[0] ?? null);
    if (!row) throw conflict("Could not create restricted execution attempt");
    if (!inserted && (
      row.principalAgentId !== agent.id
      || row.assessmentId !== input.assessmentId
      || row.sourceKind !== input.source.kind
      || row.sourceId !== input.source.id
      || row.policyId !== input.policy.id
      || row.policyVersion !== input.policy.version
      || row.nonceDigest !== pluginExecutionDigest(input.nonce)
      || row.billingCode !== input.billingCode
      || row.allowedTool !== principal.tool
      || pluginExecutionDigest(row.sanitizedEnvelope) !== pluginExecutionDigest(input.envelope)
    )) {
      await audit(row, "plugin_execution.invoke_denied", { reason: "coordinator_attempt_conflict" });
      throw conflict("Coordinator attempt identity was reused with conflicting input");
    }
    await audit(row, inserted ? "plugin_execution.invoked" : "plugin_execution.invoke_replayed", { coordinatorAttemptId: row.coordinatorAttemptId });
    return row;
  }

  async function bindHeartbeat(attemptId: string, runId: string) {
    const updated = await db.update(pluginExecutionAttempts).set({ heartbeatRunId: runId, updatedAt: new Date() }).where(and(eq(pluginExecutionAttempts.id, attemptId), eq(pluginExecutionAttempts.status, "queued"))).returning().then((rows) => rows[0] ?? null);
    if (updated) return updated;
    const row = await getRow(attemptId);
    if (!row || row.heartbeatRunId !== runId) throw conflict("Restricted execution attempt could not bind heartbeat run");
    return row;
  }

  async function start(attemptId: string, runId: string, agentId: string, adapterType: string): Promise<{ row: typeof pluginExecutionAttempts.$inferSelect; profile: Extract<AdapterExecutionProfile, { kind: "plugin_execution_tool_only" }>; token: string }> {
    let row = await getRow(attemptId);
    if (!row || row.heartbeatRunId !== runId || row.principalAgentId !== agentId) throw forbidden("Restricted execution run binding is invalid");
    if (adapterType !== "codex_local") throw unprocessable("Adapter does not support plugin_execution_tool_only", { adapterType });
    if (TERMINAL.includes(row.status as typeof TERMINAL[number])) throw conflict("Restricted execution attempt is terminal", { status: row.status });
    if (row.status !== "queued") throw conflict("Restricted execution attempt already started", { status: row.status });
    const pin = await currentPin(row);
    if (!pin.valid || !pin.skill || !pin.version) {
      await terminalize(row.id, "failed", "skill_pin_drift");
      await audit(row, "plugin_execution.pin_drift", { phase: "start" });
      throw conflict("Restricted execution skill pin drifted before start");
    }
    const now = Date.now();
    const runtimeExpiresAt = new Date(now + PLUGIN_EXECUTION_RUNTIME_MS);
    const callbackExpiresAt = new Date(now + PLUGIN_EXECUTION_CALLBACK_MS);
    const started = await db.update(pluginExecutionAttempts).set({ status: "running", startedAt: new Date(now), runtimeExpiresAt, callbackExpiresAt, updatedAt: new Date(now) }).where(and(eq(pluginExecutionAttempts.id, row.id), eq(pluginExecutionAttempts.status, "queued"))).returning().then((rows) => rows[0] ?? null);
    if (!started) {
      const current = await getRow(row.id);
      throw conflict("Restricted execution attempt could not be claimed for start", { status: current?.status ?? "missing" });
    }
    row = started;
    const scope: PluginExecutionAgentKeyScope = {
      kind: "plugin_execution", companyId: row.companyId, pluginId: row.pluginId, pluginKey: row.pluginKey,
      principalAgentId: row.principalAgentId, attemptId: row.id, assessmentId: row.assessmentId,
      sourceKind: row.sourceKind, sourceId: row.sourceId, policyId: row.policyId, policyVersion: row.policyVersion,
      skillId: row.companySkillId, skillVersionId: row.companySkillVersionId, skillRevisionNumber: row.skillRevisionNumber,
      skillContentDigest: row.skillContentDigest, tool: row.allowedTool, nonceDigest: row.nonceDigest,
      heartbeatRunId: runId, billingCode: row.billingCode, expiresAt: row.callbackExpiresAt.toISOString(),
    };
    const token = createLocalAgentJwt(agentId, row.companyId, adapterType, runId, null, scope);
    if (!token) throw conflict("Restricted execution capability signing is unavailable");
    row = await db.update(pluginExecutionAttempts).set({ capabilityTokenDigest: pluginExecutionDigest(token), updatedAt: new Date() }).where(eq(pluginExecutionAttempts.id, row.id)).returning().then((rows) => rows[0] ?? row!);
    await audit(row, "plugin_execution.minted", { expiresAt: scope.expiresAt });
    await audit(row, "plugin_execution.started");
    return {
      row,
      token,
      profile: {
        kind: "plugin_execution_tool_only",
        attemptId: row.id,
        skillId: row.companySkillId,
        skillVersionId: row.companySkillVersionId,
        skillRevisionNumber: row.skillRevisionNumber,
        skillContentDigest: row.skillContentDigest,
        tool: row.allowedTool,
        callbackExpiresAt: row.callbackExpiresAt.toISOString(),
        sanitizedEnvelope: row.sanitizedEnvelope,
        skillSnapshot: { name: pin.skill.name, slug: pin.skill.slug, files: pin.version.fileInventory.map((file) => ({ path: file.path, content: file.content })) },
      },
    };
  }

  async function terminalize(attemptId: string, status: "failed" | "cancelled" | "reclaimed" | "timed_out", reason: string) {
    const updated = await db.update(pluginExecutionAttempts).set({ status, terminalReason: reason, finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(pluginExecutionAttempts.id, attemptId), inArray(pluginExecutionAttempts.status, ["queued", "running", "callback_pending"]))).returning().then((rows) => rows[0] ?? null);
    const row = updated ?? await getRow(attemptId);
    if (!row) throw notFound("Restricted execution attempt not found");
    if (updated) await audit(row, `plugin_execution.${status}`, { reason });
    return row;
  }

  async function validateScope(scope: PluginExecutionAgentKeyScope, phase: "discovery" | "callback") {
    const row = await getRow(scope.attemptId);
    if (!row) throw forbidden("Restricted execution capability does not match its durable attempt");
    if (!sameScope(row, scope)) {
      await audit(row, "plugin_execution.callback_denied", { phase, reason: "scope_conflict" });
      throw forbidden("Restricted execution capability does not match its durable attempt");
    }
    if (["queued", "running", "callback_pending"].includes(row.status) && Date.now() >= row.runtimeExpiresAt.getTime()) {
      await terminalize(row.id, "timed_out", "runtime_deadline_exceeded");
      await audit(row, "plugin_execution.callback_denied", { phase, reason: "runtime_deadline_exceeded" });
      throw forbidden("Restricted execution runtime deadline expired");
    }
    if (Date.now() >= row.callbackExpiresAt.getTime()) {
      await terminalize(row.id, "failed", "callback_expired");
      await audit(row, "plugin_execution.callback_denied", { phase, reason: "callback_expired" });
      throw forbidden("Restricted execution callback capability expired");
    }
    const pin = await currentPin(row);
    if (!pin.valid) {
      await terminalize(row.id, "failed", "skill_pin_drift");
      await audit(row, "plugin_execution.pin_drift", { phase });
      throw conflict("Restricted execution skill pin drifted");
    }
    return row;
  }

  async function callback(scope: PluginExecutionAgentKeyScope, tool: string, parameters: unknown, dispatcher: PluginToolDispatcher) {
    const row = await validateScope(scope, "callback");
    if (tool !== row.allowedTool) {
      await audit(row, "plugin_execution.callback_denied", { reason: "tool_conflict", requestedTool: tool });
      throw forbidden("Only the bound plugin callback tool is allowed");
    }
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      await audit(row, "plugin_execution.callback_denied", { reason: "malformed_payload" });
      throw badRequest("Restricted callback payload must be an object");
    }
    if (byteLength(parameters) > PLUGIN_EXECUTION_MAX_CALLBACK_BYTES) {
      await audit(row, "plugin_execution.callback_denied", { reason: "payload_too_large" });
      throw unprocessable("Restricted callback payload exceeds 64 KiB");
    }
    const requestDigest = pluginExecutionDigest(parameters);
    if (row.status === "succeeded") {
      if (row.requestDigest === requestDigest) {
        await db.update(pluginExecutionAttempts).set({ replayState: "identical_replay", updatedAt: new Date() }).where(eq(pluginExecutionAttempts.id, row.id));
        await audit(row, "plugin_execution.callback_replayed", { requestDigest });
        return row.resultJson;
      }
      await audit(row, "plugin_execution.callback_denied", { reason: "conflicting_replay", requestDigest });
      throw conflict("Restricted callback attempt was replayed with a different request digest");
    }
    if (row.status === "callback_pending") {
      if (row.requestDigest === requestDigest) throw conflict("Identical restricted callback is already in progress");
      throw conflict("Restricted callback attempt was replayed with a different request digest");
    }
    if (row.status !== "running") {
      await audit(row, "plugin_execution.callback_denied", { reason: "non_pending", status: row.status });
      throw conflict("Restricted callback attempt is not pending", { status: row.status });
    }
    const toolRecord = dispatcher.getTool(tool);
    if (!toolRecord || toolRecord.pluginDbId !== row.pluginId || toolRecord.pluginId !== row.pluginKey) {
      await audit(row, "plugin_execution.callback_denied", { reason: "bound_tool_unavailable" });
      throw forbidden("Bound plugin callback tool is unavailable or no longer owned by the plugin");
    }
    let payloadValidation;
    try {
      payloadValidation = validateInstanceConfig(parameters as Record<string, unknown>, toolRecord.parametersSchema);
    } catch {
      await audit(row, "plugin_execution.callback_denied", { reason: "invalid_tool_schema" });
      throw forbidden("Bound plugin callback schema is invalid");
    }
    if (!payloadValidation.valid) {
      await audit(row, "plugin_execution.callback_denied", { reason: "schema_validation_failed", errors: payloadValidation.errors ?? [] });
      throw unprocessable("Restricted callback payload does not match the bound tool schema", payloadValidation.errors);
    }
    const claimed = await db.update(pluginExecutionAttempts).set({
      status: "callback_pending",
      requestDigest,
      callbackRequestJson: parameters as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(and(
      eq(pluginExecutionAttempts.id, row.id),
      eq(pluginExecutionAttempts.status, "running"),
    )).returning().then((rows) => rows[0] ?? null);
    if (!claimed) throw conflict("Restricted callback attempt was claimed concurrently");
    let execution;
    try {
      execution = await dispatcher.executeTool(tool, parameters, { agentId: row.principalAgentId, runId: row.heartbeatRunId!, companyId: row.companyId, projectId: "" });
    } catch (error) {
      await terminalize(row.id, "failed", "callback_dispatch_failed");
      await audit(row, "plugin_execution.callback_denied", { reason: "callback_dispatch_failed", requestDigest });
      throw error;
    }
    const resultJson = execution.result;
    const updated = await db.update(pluginExecutionAttempts).set({ status: "succeeded", resultDigest: pluginExecutionDigest(resultJson), resultJson, replayState: "accepted", terminalReason: "callback_succeeded", finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(pluginExecutionAttempts.id, row.id), eq(pluginExecutionAttempts.status, "callback_pending"), eq(pluginExecutionAttempts.requestDigest, requestDigest))).returning().then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Restricted execution was terminalized before callback completion");
    await audit(updated, "plugin_execution.callback_allowed", { requestDigest, resultDigest: updated.resultDigest });
    return resultJson;
  }

  async function denyScopeCall(scope: PluginExecutionAgentKeyScope, reason: string, details: Record<string, unknown> = {}) {
    const row = await getRow(scope.attemptId);
    if (!row) return;
    await audit(row, "plugin_execution.callback_denied", { reason, ...details });
  }

  return { invoke, bindHeartbeat, start, terminalize, validateScope, callback, denyScopeCall, getRow, publicAttempt };
}

export function isPluginExecutionPrincipalAgent(agent: { metadata?: Record<string, unknown> | null }): boolean {
  const managed = agent.metadata?.pluginManagedAgent;
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) return false;
  const principal = (managed as Record<string, unknown>).executionPrincipal;
  const identityOnly = (managed as Record<string, unknown>).identityOnly;
  return identityOnly === "tool_profile" || Boolean(principal && typeof principal === "object" && !Array.isArray(principal) && (principal as Record<string, unknown>).kind === "plugin_tool_only");
}
