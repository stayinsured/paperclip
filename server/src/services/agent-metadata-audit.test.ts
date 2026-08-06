import { describe, expect, it } from "vitest";
import { buildAgentMetadataAuditProjection } from "./agent-metadata-audit.js";

describe("agent metadata audit projection", () => {
  it("serializes only the strict allowlist without secret or runtime material", () => {
    const projection = buildAgentMetadataAuditProjection([{
      id: "11111111-1111-4111-8111-111111111111",
      name: "QA",
      role: "qa",
      title: "QA / Automation Engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.6-sol",
        apiKey: "adapter-secret-value",
        promptTemplate: "private prompt content",
        instructionsFilePath: "/private/agents/qa/AGENTS.md",
        env: {
          INLINE_TOKEN: { type: "plain", value: "inline-secret-value" },
          LEGACY_VALUE: "legacy-secret-value",
          SOURCE_CONTROL: {
            type: "secret_ref",
            secretId: "22222222-2222-4222-8222-222222222222",
            version: 7,
          },
          USER_HUBSPOT: {
            type: "user_secret_ref",
            key: "hubspot-sandbox",
            required: true,
          },
          MALFORMED: { type: "future_binding", value: "must-not-leak" },
        },
        paperclipSkillSync: {
          desiredSkills: [
            { key: "reflection-coach", versionId: "33333333-3333-4333-8333-333333333333" },
            "para-memory-files",
          ],
        },
      },
      runtimeConfig: {
        heartbeat: { maxConcurrentRuns: 4, intervalSec: 30 },
        admissionProfile: { productionProviderMutationAuthorized: true },
        modelProfiles: { cheap: { adapterConfig: { model: "private-cheap-model" } } },
      },
    }]);

    expect(projection).toEqual([{
      id: "11111111-1111-4111-8111-111111111111",
      name: "QA",
      role: "qa",
      title: "QA / Automation Engineer",
      status: "idle",
      adapterType: "codex_local",
      configuredModel: "gpt-5.6-sol",
      maxConcurrentRuns: 4,
      environmentBindings: [
        { name: "INLINE_TOKEN", type: "plain", target: "inline" },
        { name: "LEGACY_VALUE", type: "plain", target: "inline" },
        { name: "MALFORMED", type: "unknown", target: null },
        {
          name: "SOURCE_CONTROL",
          type: "secret_ref",
          target: "22222222-2222-4222-8222-222222222222",
        },
        { name: "USER_HUBSPOT", type: "user_secret_ref", target: "hubspot-sandbox" },
      ],
      desiredSkills: [
        { key: "para-memory-files", versionId: null },
        { key: "reflection-coach", versionId: "33333333-3333-4333-8333-333333333333" },
      ],
    }]);

    expect(Object.keys(projection[0]!)).toEqual([
      "id",
      "name",
      "role",
      "title",
      "status",
      "adapterType",
      "configuredModel",
      "maxConcurrentRuns",
      "environmentBindings",
      "desiredSkills",
    ]);
    const serialized = JSON.stringify(projection);
    for (const forbiddenValue of [
      "adapter-secret-value",
      "private prompt content",
      "/private/agents/qa/AGENTS.md",
      "inline-secret-value",
      "legacy-secret-value",
      "must-not-leak",
      "private-cheap-model",
    ]) {
      expect(serialized).not.toContain(forbiddenValue);
    }
  });
});
