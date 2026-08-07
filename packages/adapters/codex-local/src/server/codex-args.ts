import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  normalizeCodexModel,
} from "../index.js";

const SKIP_GIT_REPO_CHECK_FLAG = "--skip-git-repo-check";

const OUTPUT_ONLY_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "default_mode_request_user_input",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
};

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
    outputOnly?: boolean;
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const model = normalizeCodexModel(asString(record.model, ""));
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const outputOnly = options.outputOnly === true;
  const search = !outputOnly && asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = !outputOnly && asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const extraArgs = readExtraArgs(record);

  const args = ["exec", "--json"];
  // Codex rejects a repeated `--skip-git-repo-check` ("cannot be used multiple
  // times"). The adapter injects this flag for sandbox execution, so when an
  // operator's extraArgs already carry it the injection would abort the run
  // with exit code 2. Skip the injection in that case and let the operator's
  // copy stand.
  if (options.skipGitRepoCheck && (outputOnly || !extraArgs.includes(SKIP_GIT_REPO_CHECK_FLAG))) {
    args.push(SKIP_GIT_REPO_CHECK_FLAG);
  }
  if (search) args.unshift("--search");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (extraArgs.length > 0 && !outputOnly) args.push(...extraArgs);
  if (outputOnly) {
    args.push(
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--strict-config",
      "-c",
      "web_search=\"disabled\"",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "project_doc_fallback_filenames=[]",
      "-c",
      "project_root_markers=[]",
      "-c",
      "mcp_servers={}",
    );
    for (const feature of OUTPUT_ONLY_DISABLED_FEATURES) args.push("--disable", feature);
  }
  if (options.resumeSessionId && !outputOnly) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
  };
}
