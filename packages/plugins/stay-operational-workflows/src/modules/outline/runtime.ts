import type {
  ManagedToolProfileInvocationResult,
  PluginManagedToolProfilesClient,
} from "@paperclipai/plugin-sdk";
import { isOutlineActiveConfig, type ModuleConfig } from "../../contracts.js";
import { outlineActivationDenial, parseOutlineModuleActivation } from "./activation.js";
import { sha256 } from "./identity.js";
import { OutlineAmbiguousWriteError, OutlineMcpError } from "./mcp.js";
import type {
  OutlineDestinationConfig,
  OutlineDocument,
  OutlineMcpPort,
  OutlinePublishingAuthorization,
  OutlineShadowPreview,
} from "./types.js";

export interface OutlineActivationBinding {
  destination: OutlineDestinationConfig;
  authorization: OutlinePublishingAuthorization;
  api: OutlineMcpPort;
}

export interface OutlineRuntimePort {
  resolve(config: ModuleConfig): OutlineActivationBinding | { deniedCode: string } | null;
  loadPreview(companyId: string, sourceIssueId: string, policyVersion: string): Promise<OutlineShadowPreview | null>;
}

export interface OutlineRuntimeOptions {
  assessments: {
    get(companyId: string, sourceIssueId: string, policyVersion: string): Promise<{ preview: OutlineShadowPreview | null } | null>;
  };
  mcpConnectionFactory?: (destination: OutlineDestinationConfig, authorization: OutlinePublishingAuthorization) => OutlineMcpPort | null;
  managedToolProfiles?: Pick<PluginManagedToolProfilesClient, "invoke">;
  now?: () => Date;
}

const PROFILE_KEY = "outline";
const TOOL = {
  list: "list_documents",
  create: "create_document",
  update: "update_document",
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function documentCandidates(value: unknown, depth = 0): unknown[] {
  if (depth > 10 || value == null) return [];
  if (typeof value === "string") {
    try {
      return documentCandidates(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap((entry) => documentCandidates(entry, depth + 1));
  if (!isObject(value)) return [];
  const directId = value.id ?? value.documentId ?? value.document_id;
  if (typeof directId === "string") return [value];
  return ["document", "documents", "data", "result", "content", "text"]
    .flatMap((key) => documentCandidates(value[key], depth + 1));
}

function optionalString(...values: unknown[]): string | null {
  const value = values.find((candidate) => typeof candidate === "string");
  return typeof value === "string" ? value : null;
}

function parseDocument(value: unknown, expectedId: string): OutlineDocument | null {
  for (const candidate of documentCandidates(value)) {
    if (!isObject(candidate)) continue;
    const id = optionalString(candidate.id, candidate.documentId, candidate.document_id);
    if (!id || id !== expectedId) continue;
    const collection = isObject(candidate.collection) ? candidate.collection : null;
    const parent = isObject(candidate.parentDocument) ? candidate.parentDocument : null;
    const collectionId = optionalString(candidate.collectionId, candidate.collection_id, collection?.id);
    const title = optionalString(candidate.title);
    const text = optionalString(candidate.text, candidate.body, candidate.bodyMarkdown);
    if (!collectionId || !title || text == null) continue;
    return {
      id,
      collectionId,
      parentDocumentId: optionalString(candidate.parentDocumentId, candidate.parent_document_id, parent?.id),
      title,
      text,
      url: optionalString(candidate.url),
      updatedAt: optionalString(candidate.updatedAt, candidate.updated_at),
    };
  }
  return null;
}

function throwReceiptError(invocation: ManagedToolProfileInvocationResult, write: boolean): never {
  const { receipt } = invocation;
  const code = receipt.errorCode ?? `outline_mcp_${receipt.outcome}`;
  if (receipt.outcome === "ambiguous" || (write && receipt.outcome === "failed")) {
    throw new OutlineAmbiguousWriteError(code);
  }
  throw new OutlineMcpError(code, receipt.outcome === "rate_limited" || receipt.outcome === "failed");
}

function createManagedOutlineMcpPort(
  companyId: string,
  client: Pick<PluginManagedToolProfilesClient, "invoke">,
  session: string,
): OutlineMcpPort {
  let readSequence = 0;
  const invoke = async (
    toolName: typeof TOOL[keyof typeof TOOL],
    parameters: unknown,
    idempotencyKey: string,
    write: boolean,
  ): Promise<ManagedToolProfileInvocationResult> => {
    const invocation = await client.invoke({
      companyId,
      profileKey: PROFILE_KEY,
      toolName,
      parameters,
      idempotencyKey,
      timeoutMs: 30_000,
    });
    if (invocation.receipt.outcome !== "succeeded") throwReceiptError(invocation, write);
    return invocation;
  };

  return {
    async getDocument(id) {
      const invocation = await invoke(
        TOOL.list,
        { id },
        `outline:list:${session}:${++readSequence}:${id}`,
        false,
      );
      if (invocation.result === undefined && invocation.receipt.replayed) {
        throw new OutlineMcpError("outline_mcp_replayed_read_without_result", true);
      }
      return parseDocument(invocation.result, id);
    },
    async createDocument(input) {
      const invocation = await invoke(
        TOOL.create,
        input,
        `outline:create:${session}:${input.id}:${sha256(input.text)}`,
        true,
      );
      return parseDocument(invocation.result, input.id) ?? { ...input };
    },
    async updateDocument(input) {
      const invocation = await invoke(
        TOOL.update,
        input,
        `outline:update:${session}:${input.id}:${sha256(input.text)}`,
        true,
      );
      const parsed = parseDocument(invocation.result, input.id);
      return parsed ?? { ...input, collectionId: "", parentDocumentId: null };
    },
  };
}

export function createOutlineRuntime(options: OutlineRuntimeOptions): OutlineRuntimePort {
  const now = options.now ?? (() => new Date());
  const runtimeEpoch = now().getTime().toString(36);
  let session = 0;
  return {
    resolve(config) {
      if (!isOutlineActiveConfig(config)) return null;
      let activation;
      try {
        activation = parseOutlineModuleActivation(config.outlineActivation);
      } catch {
        return { deniedCode: "outline_activation_invalid" };
      }
      const denial = outlineActivationDenial(activation, now());
      if (denial) return { deniedCode: denial };
      const api = options.mcpConnectionFactory?.(activation.destination, activation.authorization)
        ?? (options.managedToolProfiles
          ? createManagedOutlineMcpPort(config.companyId, options.managedToolProfiles, `${runtimeEpoch}:${++session}`)
          : null);
      if (!api) return { deniedCode: "outline_mcp_runtime_unavailable" };
      return {
        destination: activation.destination,
        authorization: activation.authorization,
        api,
      };
    },
    async loadPreview(companyId, sourceIssueId, policyVersion) {
      const record = await options.assessments.get(companyId, sourceIssueId, policyVersion);
      return record?.preview ?? null;
    },
  };
}
