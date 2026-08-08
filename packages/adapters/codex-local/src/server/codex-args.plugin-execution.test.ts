import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("plugin_execution_tool_only Codex arguments", () => {
  it("is fresh and sealed while retaining the host-owned MCP config", () => {
    const result = buildCodexExecArgs({
      search: true,
      dangerouslyBypassApprovalsAndSandbox: true,
      extraArgs: ["--enable", "shell_tool", "resume", "old-thread"],
    }, { resumeSessionId: "persisted-thread", pluginToolOnly: true });

    expect(result.args).toContain("--skip-git-repo-check");
    expect(result.args).toContain("--ignore-user-config");
    expect(result.args).toContain("--ignore-rules");
    expect(result.args).toContain("--ephemeral");
    expect(result.args).not.toContain("--search");
    expect(result.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(result.args).not.toContain("--enable");
    expect(result.args).not.toContain("resume");
    expect(result.args).not.toContain("mcp_servers={}");
    for (const feature of ["shell_tool", "unified_exec", "browser_use", "plugins", "skill_search"]) {
      expect(result.args[result.args.indexOf(feature) - 1]).toBe("--disable");
    }
  });

  it("keeps skill_test_output_only at zero MCP", () => {
    const result = buildCodexExecArgs({}, { outputOnly: true });
    expect(result.args).toContain("mcp_servers={}");
  });
});
