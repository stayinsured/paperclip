import { describe, expect, it } from "vitest";
import { registerReflectionProposalSchema } from "./reflection.js";

describe("reflection proposal validation", () => {
  it("preserves a three-target proposal with explicit terminal no-change evidence", () => {
    const parsed = registerReflectionProposalSchema.parse({
      version: 1,
      proposalKey: "weekly:agent-1:2026-08-31",
      targets: [
        {
          targetKey: "agent:agent-1:instructions",
          targetType: "agent_instructions",
          targetLabel: "Agent instructions",
          proposalRevision: "instructions-v1",
          proposedDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,2 @@\n-old\n+new",
        },
        {
          targetKey: "agent:agent-1:profile",
          targetType: "agent_profile",
          targetLabel: "Agent profile",
          proposalRevision: "profile-v1",
          proposedDiff: "--- a/profile\n+++ b/profile\n@@ -1,1 +1,1 @@\n-old\n+new",
        },
        {
          targetKey: "skills:scan-projects",
          targetType: "skills_scan",
          targetLabel: "Skill scan",
          proposalRevision: "scan-v1",
          state: "evidence_backed_no_change",
          evidenceMarkdown: "The existing skill coverage already matches the observed failure mode.",
        },
      ],
    });

    expect(parsed.targets.map((target) => target.state)).toEqual([
      "proposed",
      "proposed",
      "evidence_backed_no_change",
    ]);
  });

  it("rejects missing evidence and duplicate target revisions", () => {
    expect(() => registerReflectionProposalSchema.parse({
      version: 1,
      proposalKey: "proposal-1",
      targets: [{
        targetKey: "agent:agent-1:instructions",
        targetType: "agent_instructions",
        targetLabel: "Instructions",
        proposalRevision: "v1",
      }],
    })).toThrow("proposed targets require proposedDiff");

    expect(() => registerReflectionProposalSchema.parse({
      version: 1,
      proposalKey: "proposal-1",
      targets: [
        {
          targetKey: "agent:agent-1:instructions",
          targetType: "agent_instructions",
          targetLabel: "Instructions",
          proposalRevision: "v1",
          proposedDiff: "diff one",
        },
        {
          targetKey: "agent:agent-1:instructions",
          targetType: "agent_instructions",
          targetLabel: "Instructions duplicate",
          proposalRevision: "v1",
          proposedDiff: "diff two",
        },
      ],
    })).toThrow("targetKey and proposalRevision must be unique");
  });
});
