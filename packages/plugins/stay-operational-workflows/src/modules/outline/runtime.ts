import { isOutlineActiveConfig, type ModuleConfig } from "../../contracts.js";
import { outlineActivationDenial } from "./activation.js";
import type {
  OutlineDestinationConfig,
  OutlineMcpPort,
  OutlinePublishingAuthorization,
  OutlineShadowPreview,
} from "./types.js";

export interface OutlineActivationBinding {
  destination: OutlineDestinationConfig;
  authorization: OutlinePublishingAuthorization;
  api: OutlineMcpPort;
}

/**
 * Runtime seam between reconciliation and the guarded Outline publisher.
 *
 * resolve() answers one question per module config: may this reconciliation
 * publish right now? `null` means the config is structurally shadow-only.
 * A `deniedCode` result means the config is switched on for publishing but a
 * gate currently fails (kill switch, approval drift, expired writer proof, or
 * no bound MCP runtime) — reconciliation then fails closed to shadow with a
 * visible exception and zero provider writes.
 */
export interface OutlineRuntimePort {
  resolve(config: ModuleConfig): OutlineActivationBinding | { deniedCode: string } | null;
  loadPreview(companyId: string, sourceIssueId: string, policyVersion: string): Promise<OutlineShadowPreview | null>;
}

export interface OutlineRuntimeOptions {
  assessments: {
    get(companyId: string, sourceIssueId: string, policyVersion: string): Promise<{ preview: OutlineShadowPreview | null } | null>;
  };
  mcpConnectionFactory?: (destination: OutlineDestinationConfig, authorization: OutlinePublishingAuthorization) => OutlineMcpPort | null;
  now?: () => Date;
}

export function createOutlineRuntime(options: OutlineRuntimeOptions): OutlineRuntimePort {
  const now = options.now ?? (() => new Date());
  return {
    resolve(config) {
      if (!isOutlineActiveConfig(config)) return null;
      const activation = config.outlineActivation!;
      const denial = outlineActivationDenial(activation, now());
      if (denial) return { deniedCode: denial };
      const api = options.mcpConnectionFactory?.(activation.destination, activation.authorization) ?? null;
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
