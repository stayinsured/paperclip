import { describe, expect, it } from "vitest";
import { pluginExecutionAgentKeyScopeSchema } from "./agent.js";
import { pluginManifestV1Schema } from "./plugin.js";

const baseManifest = {
  id: "paperclip.classifier",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Classifier",
  description: "Restricted model classifier.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agents.managed", "skills.managed", "agent.tools.register"],
  entrypoints: { worker: "./dist/worker.js" },
  tools: [{ name: "maintain-document", displayName: "Maintain document", description: "Create or update one document", parametersSchema: { type: "object" } }],
  skills: [{ skillKey: "classify", displayName: "Classify" }],
  agents: [{
    agentKey: "classifier",
    displayName: "Classifier",
    adapterType: "codex_local",
    executionPrincipal: { kind: "plugin_tool_only", skillKey: "classify", tool: "paperclip.classifier:maintain-document" },
  }],
} as const;

describe("restricted plugin execution contracts", () => {
  it("accepts one exact plugin-owned skill and namespaced tool", () => {
    expect(pluginManifestV1Schema.parse(baseManifest).agents?.[0]?.executionPrincipal).toEqual(baseManifest.agents[0].executionPrincipal);
  });

  it("rejects ordinary permissions and unowned skill or tool declarations", () => {
    for (const executionPrincipal of [
      { kind: "plugin_tool_only", skillKey: "missing", tool: "paperclip.classifier:maintain-document" },
      { kind: "plugin_tool_only", skillKey: "classify", tool: "other.plugin:maintain-document" },
    ]) {
      expect(pluginManifestV1Schema.safeParse({ ...baseManifest, agents: [{ ...baseManifest.agents[0], executionPrincipal }] }).success).toBe(false);
    }
    expect(pluginManifestV1Schema.safeParse({ ...baseManifest, agents: [{ ...baseManifest.agents[0], permissions: { canCreateAgents: true } }] }).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse({ ...baseManifest, agents: [{ ...baseManifest.agents[0], role: "ceo" }] }).success).toBe(false);
  });

  it("requires every signed identity and rejects unknown capability fields", () => {
    const scope = {
      kind: "plugin_execution", companyId: "11111111-1111-4111-8111-111111111111", pluginId: "22222222-2222-4222-8222-222222222222",
      pluginKey: "paperclip.classifier", principalAgentId: "33333333-3333-4333-8333-333333333333", attemptId: "44444444-4444-4444-8444-444444444444",
      assessmentId: "a-1", sourceKind: "issue", sourceId: "source-1", policyId: "policy", policyVersion: "1",
      skillId: "55555555-5555-4555-8555-555555555555", skillVersionId: "66666666-6666-4666-8666-666666666666", skillRevisionNumber: 1,
      skillContentDigest: `sha256:${"a".repeat(64)}`, tool: "paperclip.classifier:maintain-document", nonceDigest: `sha256:${"b".repeat(64)}`,
      heartbeatRunId: "77777777-7777-4777-8777-777777777777", billingCode: "STA-1832/outline-materiality", expiresAt: "2026-08-08T12:00:00.000Z",
    } as const;
    expect(pluginExecutionAgentKeyScopeSchema.safeParse(scope).success).toBe(true);
    expect(pluginExecutionAgentKeyScopeSchema.safeParse({ ...scope, issueId: "not-allowed" }).success).toBe(false);
    const { policyId: _removed, ...missingPolicy } = scope;
    expect(pluginExecutionAgentKeyScopeSchema.safeParse(missingPolicy).success).toBe(false);
  });
});
