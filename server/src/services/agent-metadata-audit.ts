import type {
  AgentAdapterType,
  AgentMetadataAuditEntry,
  AgentMetadataAuditEnvironmentBinding,
  AgentMetadataAuditSkillIdentity,
  AgentStatus,
} from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";

type AgentMetadataAuditSource = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  adapterType: AgentAdapterType;
  adapterConfig: unknown;
  runtimeConfig: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readEnvironmentBinding(
  name: string,
  rawBinding: unknown,
): AgentMetadataAuditEnvironmentBinding {
  if (typeof rawBinding === "string") {
    return { name, type: "plain", target: "inline" };
  }

  const binding = asRecord(rawBinding);
  if (!binding || typeof binding.type !== "string") {
    return { name, type: "unknown", target: null };
  }
  if (binding.type === "plain") {
    return { name, type: "plain", target: "inline" };
  }
  if (binding.type === "secret_ref") {
    return {
      name,
      type: "secret_ref",
      target: typeof binding.secretId === "string" && binding.secretId.trim()
        ? binding.secretId
        : null,
    };
  }
  if (binding.type === "user_secret_ref") {
    return {
      name,
      type: "user_secret_ref",
      target: typeof binding.key === "string" && binding.key.trim()
        ? binding.key
        : null,
    };
  }
  return { name, type: "unknown", target: null };
}

function readEnvironmentBindings(adapterConfig: unknown) {
  const env = asRecord(asRecord(adapterConfig)?.env);
  if (!env) return [];
  return Object.entries(env)
    .map(([name, binding]) => readEnvironmentBinding(name, binding))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readDesiredSkillIdentities(adapterConfig: unknown): AgentMetadataAuditSkillIdentity[] {
  const config = asRecord(adapterConfig) ?? {};
  const entries = readPaperclipSkillSyncPreference(config).desiredSkillEntries;
  const byIdentity = new Map<string, AgentMetadataAuditSkillIdentity>();
  for (const entry of entries) {
    const identity = `${entry.key}\u0000${entry.versionId ?? ""}`;
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, { key: entry.key, versionId: entry.versionId ?? null });
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.key.localeCompare(right.key) || (left.versionId ?? "").localeCompare(right.versionId ?? "")
  );
}

export function buildAgentMetadataAuditEntry(
  agent: AgentMetadataAuditSource,
): AgentMetadataAuditEntry {
  const adapterConfig = asRecord(agent.adapterConfig);
  const heartbeat = asRecord(asRecord(agent.runtimeConfig)?.heartbeat);
  const configuredModel = typeof adapterConfig?.model === "string"
    ? adapterConfig.model
    : null;
  const maxConcurrentRuns = typeof heartbeat?.maxConcurrentRuns === "number"
    && Number.isFinite(heartbeat.maxConcurrentRuns)
    ? heartbeat.maxConcurrentRuns
    : null;

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status as AgentStatus,
    adapterType: agent.adapterType,
    configuredModel,
    maxConcurrentRuns,
    environmentBindings: readEnvironmentBindings(agent.adapterConfig),
    desiredSkills: readDesiredSkillIdentities(agent.adapterConfig),
  };
}

export function buildAgentMetadataAuditProjection(
  agents: AgentMetadataAuditSource[],
): AgentMetadataAuditEntry[] {
  return agents
    .map(buildAgentMetadataAuditEntry)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}
