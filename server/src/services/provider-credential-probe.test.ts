import { describe, expect, it, vi } from "vitest";
import { providerCredentialCapabilityMetadataSchema } from "@paperclipai/shared";
import { runDisposableProviderCredentialProbe } from "./provider-credential-probe.js";
function metadata(environment: "sandbox" | "production" = "sandbox") {
  return providerCredentialCapabilityMetadataSchema.parse({ provider: "hubspot", account: { id: "portal" }, environment, client: { id: "app" }, expiresAt: null, scopes: ["forms"], endpointObjects: [{ endpoint: "/marketing/v3/forms", object: "form", generation: "v4-builder" }], capabilities: [{ alias: "forms.v4-builder.create", access: "mutation", endpoint: "/marketing/v3/forms", method: "POST", object: "form", generation: "v4-builder" }], lastVerifiedAt: null, runtimeOwners: [{ owner: "backend-integrations", action: "Refresh sandbox app allowlist." }] });
}
describe("disposable provider credential probe", () => {
  it("creates, reads back, removes, and confirms absence", async () => {
    let object: { id: string } | null = null;
    const adapter = { create: vi.fn(async () => (object = { id: "disposable-form" })), read: vi.fn(async () => object), remove: vi.fn(async () => { object = null; }) };
    await expect(runDisposableProviderCredentialProbe({ metadata: metadata(), capabilityAlias: "forms.v4-builder.create", target: { environment: "sandbox", disposable: true, name: "STA-2714 probe" }, adapter })).resolves.toMatchObject({ createdId: "disposable-form", createReadback: "verified", cleanupReadback: "verified_absent" });
    expect(adapter.read).toHaveBeenCalledTimes(2); expect(adapter.remove).toHaveBeenCalledTimes(1);
  });
  it("deny-lists production before provider I/O", async () => {
    const adapter = { create: vi.fn(), read: vi.fn(), remove: vi.fn() };
    await expect(runDisposableProviderCredentialProbe({ metadata: metadata("production"), capabilityAlias: "forms.v4-builder.create", target: { environment: "sandbox", disposable: true, name: "never" }, adapter })).rejects.toThrow("deny-listed");
    expect(adapter.create).not.toHaveBeenCalled();
  });
  it("cleans up when create readback rejects capability", async () => {
    const adapter = { create: vi.fn(async () => ({ id: "probe" })), read: vi.fn(async () => null), remove: vi.fn(async () => undefined) };
    await expect(runDisposableProviderCredentialProbe({ metadata: metadata(), capabilityAlias: "forms.v4-builder.create", target: { environment: "sandbox", disposable: true, name: "probe" }, adapter })).rejects.toThrow("readback failed");
    expect(adapter.remove).toHaveBeenCalledWith("probe");
  });
});
