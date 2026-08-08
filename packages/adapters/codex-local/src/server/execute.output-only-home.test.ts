import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({
    notes: [],
    cleanup: vi.fn(async () => undefined),
  })),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return { ...actual, prepareCodexRuntimeConfig };
});

import { CODEX_OUTPUT_ONLY_CREDENTIAL_ERROR_CODE } from "./codex-home.js";
import { execute, executeResponseOnly } from "./execute.js";

type InvocationCapture = {
  command: string;
  args: string[];
  codexHome: string;
  entries: string[];
  authIsSymlink: boolean;
  authMode: number;
  authPayload: unknown;
  cwd: string;
  stdin: string;
  envKeys: string[];
};

describe("codex output-only credential home", () => {
  const cleanupDirs: string[] = [];
  let capture: InvocationCapture | null = null;

  beforeEach(() => {
    capture = null;
    vi.clearAllMocks();
    runAdapterExecutionTargetProcess.mockImplementation(
      async (
        _runId: string,
        _target: unknown,
        command: string,
        args: string[],
        options: { env: Record<string, string>; cwd: string; stdin: string },
      ) => {
        const codexHome = options.env.CODEX_HOME;
        const authPath = path.join(codexHome, "auth.json");
        capture = {
          command,
          args,
          codexHome,
          entries: (await fs.readdir(codexHome)).sort(),
          authIsSymlink: (await fs.lstat(authPath)).isSymbolicLink(),
          authMode: (await fs.stat(authPath)).mode & 0o777,
          authPayload: JSON.parse(await fs.readFile(authPath, "utf8")),
          cwd: options.cwd,
          stdin: options.stdin,
          envKeys: Object.keys(options.env).sort(),
        };
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "output-only-thread" }),
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "rendered output" },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            }),
          ].join("\n"),
          stderr: "",
          pid: 123,
          startedAt: new Date().toISOString(),
        };
      },
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-output-execute-"));
    cleanupDirs.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const workspaceDir = path.join(root, "workspace");
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedCodexHome);
    vi.stubEnv("PAPERCLIP_CODEX_AUTH_CACHE", "off");
    return { root, sharedCodexHome, workspaceDir, managedAgentHome };
  }

  function buildContext(input: {
    workspaceDir: string;
    managedAgentHome: string;
    apiKey?: string;
  }) {
    return {
      runId: "run-output-only-home",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Output Renderer",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "untrusted-custom-command",
        cwd: input.workspaceDir,
        outputInactivityTimeoutMs: null,
        env: {
          CODEX_HOME: input.managedAgentHome,
          OPENAI_API_KEY: input.apiKey ?? "",
        },
      },
      context: {},
      executionProfile: {
        kind: "skill_test_output_only" as const,
        testRunId: "test-run-1",
        issueId: "issue-1",
        outputDocumentKey: "output" as const,
      },
      onLog: vi.fn(async () => undefined),
    };
  }

  it("executes the dedicated response-only entry with the exact sealed prompt and zero tool surfaces", async () => {
    const fx = await makeFixture();
    await fs.writeFile(path.join(fx.sharedCodexHome, "auth.json"), JSON.stringify({
      tokens: { account_id: "acct-response-only", access_token: "access", refresh_token: "refresh" },
    }), { mode: 0o600 });
    const onMeta = vi.fn(async () => undefined);
    const prompt = JSON.stringify({
      renderedTemplateBody: "Persisted template",
      inputSnapshot: "Persisted input",
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: "Pinned content" }],
    });

    const result = await executeResponseOnly({
      runId: "run-response-only",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Response Renderer",
        adapterType: "codex_local",
        adapterConfig: { instructionsFilePath: "/must/not/load" },
      },
      config: {
        model: "gpt-test",
        command: "untrusted-command",
        instructionsFilePath: "/must/not/load",
        paperclipSkillSync: { desiredSkills: ["must-not-sync"] },
        mcpServers: { unsafe: { url: "https://example.invalid" } },
      },
      prompt,
      scratchDir: fx.workspaceDir,
      testRunId: "test-run-1",
      issueId: "issue-1",
      onLog: vi.fn(async () => undefined),
      onMeta,
    });

    expect(result.exitCode).toBe(0);
    expect(capture).toMatchObject({ command: "codex", cwd: fx.workspaceDir, stdin: prompt });
    expect(capture?.args).toEqual(expect.arrayContaining([
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--strict-config",
      "unified_exec",
      "shell_tool",
      "plugins",
    ]));
    expect(capture?.args).not.toContain("untrusted-command");
    expect(capture?.envKeys.some((key) => key.startsWith("PAPERCLIP_"))).toBe(false);
    expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({
      prompt,
      context: { paperclipResponseOnlyPrompt: prompt },
    }));
    expect(prepareCodexRuntimeConfig).not.toHaveBeenCalled();
  });

  it("launches subscription mode without reading inherited config or runtime entries", async () => {
    const fx = await makeFixture();
    const subscriptionAuth = {
      tokens: {
        account_id: "acct-output-only",
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
      },
    };
    await fs.writeFile(
      path.join(fx.sharedCodexHome, "auth.json"),
      JSON.stringify(subscriptionAuth),
      { mode: 0o600 },
    );
    // Full seeding would fail trying to copy this directory as a file.
    await fs.mkdir(path.join(fx.sharedCodexHome, "config.toml"));
    await fs.writeFile(path.join(fx.sharedCodexHome, "config.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(fx.sharedCodexHome, "instructions.md"), "do not inherit\n", "utf8");
    for (const name of ["skills", "sessions", "mcp", "plugins", "shell_snapshots"]) {
      await fs.mkdir(path.join(fx.sharedCodexHome, name));
      await fs.writeFile(path.join(fx.sharedCodexHome, name, "sentinel"), name, "utf8");
    }

    const result = await execute(buildContext(fx));

    expect(result.exitCode).toBe(0);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
    expect(prepareCodexRuntimeConfig).not.toHaveBeenCalled();
    expect(capture).toMatchObject({
      command: "codex",
      entries: ["auth.json"],
      authIsSymlink: true,
      authMode: 0o600,
      authPayload: subscriptionAuth,
    });
    expect(capture?.codexHome).not.toBe(fx.managedAgentHome);
    expect(path.dirname(capture!.codexHome)).toBe(path.dirname(fx.managedAgentHome));
    await expect(fs.access(capture!.codexHome)).rejects.toBeTruthy();
  });

  it("launches configured API-key mode with a private regular auth file", async () => {
    const fx = await makeFixture();
    await fs.mkdir(path.join(fx.sharedCodexHome, "config.toml"));

    const result = await execute(buildContext({ ...fx, apiKey: "sk-output-only" }));

    expect(result.exitCode).toBe(0);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
    expect(prepareCodexRuntimeConfig).not.toHaveBeenCalled();
    expect(capture).toMatchObject({
      entries: ["auth.json"],
      authIsSymlink: false,
      authMode: 0o600,
      authPayload: { OPENAI_API_KEY: "sk-output-only" },
    });
    await expect(fs.access(capture!.codexHome)).rejects.toBeTruthy();
  });

  it.each(["missing", "unreadable"] as const)(
    "fails before provider execution when subscription auth is %s",
    async (failureMode) => {
      const fx = await makeFixture();
      if (failureMode === "unreadable") {
        await fs.mkdir(path.join(fx.sharedCodexHome, "auth.json"));
      }

      await expect(execute(buildContext(fx))).rejects.toMatchObject({
        name: "CodexOutputOnlyCredentialError",
        code: CODEX_OUTPUT_ONLY_CREDENTIAL_ERROR_CODE,
        resultJson: {
          authMode: "subscription",
          failure: "missing_unreadable_or_unusable",
        },
      });

      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
      expect(prepareCodexRuntimeConfig).not.toHaveBeenCalled();
    },
  );
});
