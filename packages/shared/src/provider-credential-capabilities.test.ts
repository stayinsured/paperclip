import { describe, expect, it } from "vitest";
import { admitProviderCredential, providerCredentialCapabilityMetadataSchema } from "./provider-credential-capabilities.js";
export const metadata = providerCredentialCapabilityMetadataSchema.parse({
  provider: "hubspot", account: { id: "sandbox-portal-123" }, environment: "sandbox", client: { id: "private-app-456" }, expiresAt: "2027-01-01T00:00:00.000Z", scopes: ["forms"],
  endpointObjects: [{ endpoint: "/marketing/v3/forms", object: "form", generation: "v4-builder" }], capabilities: [
    { alias: "forms.v3.read", access: "read", endpoint: "/marketing/v3/forms/{id}", method: "GET", object: "form", generation: "v3" },
    { alias: "forms.v4-builder.create", access: "mutation", endpoint: "/marketing/v3/forms", method: "POST", object: "form", generation: "v4-builder" },
  ], lastVerifiedAt: "2026-08-26T12:00:00.000Z", runtimeOwners: [{ owner: "backend-integrations", action: "Re-authorize the sandbox app and rerun the exact probe." }],
});
describe("provider credential capability metadata", () => {
  it("is complete, secret-free, and strict", () => {
    expect(metadata).toMatchObject({ provider: "hubspot", account: { id: "sandbox-portal-123" }, environment: "sandbox", client: { id: "private-app-456" }, scopes: ["forms"], lastVerifiedAt: expect.any(String), runtimeOwners: [expect.any(Object)] });
    expect(() => providerCredentialCapabilityMetadataSchema.parse({ ...metadata, accessToken: "do-not-store" })).toThrow();
  });
  it("requires the exact mutation alias, not a broad scope or read alias", () => {
    expect(admitProviderCredential({ metadata, capabilityAlias: "forms.v4-builder.create", environment: "sandbox", now: new Date("2026-08-27") })).toMatchObject({ admitted: true, capability: { access: "mutation", generation: "v4-builder" } });
    expect(admitProviderCredential({ metadata, capabilityAlias: "forms.v4-builder.update", environment: "sandbox" })).toMatchObject({ admitted: false, code: "capability_unverified", owner: "backend-integrations" });
  });
  it("fails closed for expiry and wrong environment with owner/action", () => {
    expect(admitProviderCredential({ metadata, capabilityAlias: "forms.v4-builder.create", environment: "production" })).toMatchObject({ admitted: false, code: "wrong_environment", action: expect.stringContaining("Re-authorize") });
    expect(admitProviderCredential({ metadata, capabilityAlias: "forms.v4-builder.create", environment: "sandbox", now: new Date("2028-01-01") })).toMatchObject({ admitted: false, code: "expired", owner: "backend-integrations" });
  });
});
