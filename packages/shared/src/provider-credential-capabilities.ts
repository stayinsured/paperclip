import { z } from "zod";
const identifier = z.string().trim().min(1).max(240);
export const providerCredentialEnvironmentSchema = z.enum(["development", "test", "sandbox", "production"]);
export const providerCredentialCapabilitySchema = z.object({
  alias: identifier, access: z.enum(["read", "mutation"]), endpoint: z.string().trim().startsWith("/").max(500),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), object: identifier, generation: identifier,
}).strict().superRefine((value, ctx) => {
  if (value.access === "read" && value.method !== "GET") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["method"], message: "Read capabilities must use GET" });
  if (value.access === "mutation" && value.method === "GET") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["method"], message: "Mutation capabilities cannot use GET" });
});
export const providerCredentialCapabilityMetadataSchema = z.object({
  provider: identifier,
  account: z.object({ id: identifier, label: identifier.optional() }).strict(),
  environment: providerCredentialEnvironmentSchema,
  client: z.object({ id: identifier, label: identifier.optional() }).strict(),
  expiresAt: z.string().datetime({ offset: true }).nullable(), scopes: z.array(identifier).max(200),
  endpointObjects: z.array(z.object({ endpoint: z.string().trim().startsWith("/").max(500), object: identifier, generation: identifier }).strict()).min(1).max(200),
  capabilities: z.array(providerCredentialCapabilitySchema).min(1).max(200),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  runtimeOwners: z.array(z.object({ owner: identifier, action: z.string().trim().min(1).max(500) }).strict()).min(1).max(20),
}).strict();
export type ProviderCredentialCapabilityMetadata = z.infer<typeof providerCredentialCapabilityMetadataSchema>;
export type ProviderCredentialCapability = z.infer<typeof providerCredentialCapabilitySchema>;
export type ProviderCredentialAdmission = { admitted: true; capability: ProviderCredentialCapability } | { admitted: false; code: "expired" | "wrong_environment" | "capability_unverified"; owner: string; action: string };
/** Secret-free, fail-closed admission for one exact provider operation. */
export function admitProviderCredential(input: { metadata: ProviderCredentialCapabilityMetadata; capabilityAlias: string; environment: z.infer<typeof providerCredentialEnvironmentSchema>; now?: Date }): ProviderCredentialAdmission {
  const owner = input.metadata.runtimeOwners[0]!;
  if (input.metadata.environment !== input.environment) return { admitted: false, code: "wrong_environment", owner: owner.owner, action: owner.action };
  if (input.metadata.expiresAt && Date.parse(input.metadata.expiresAt) <= (input.now ?? new Date()).getTime()) return { admitted: false, code: "expired", owner: owner.owner, action: owner.action };
  const capability = input.metadata.capabilities.find((item) => item.alias === input.capabilityAlias);
  if (!capability) return { admitted: false, code: "capability_unverified", owner: owner.owner, action: owner.action };
  return { admitted: true, capability };
}
