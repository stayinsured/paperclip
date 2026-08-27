import { admitProviderCredential, type ProviderCredentialCapabilityMetadata } from "@paperclipai/shared";
export interface DisposableProviderProbeAdapter<TObject extends { id: string }> { create(input: { name: string }): Promise<TObject>; read(id: string): Promise<TObject | null>; remove(id: string): Promise<void>; }
export interface ProviderCredentialProbeResult { capabilityAlias: string; createdId: string; createReadback: "verified"; cleanupReadback: "verified_absent"; }
/** Executes an exact write/read/delete/read lifecycle. Credential material remains inside the provider adapter. */
export async function runDisposableProviderCredentialProbe<TObject extends { id: string }>(input: {
  metadata: ProviderCredentialCapabilityMetadata; capabilityAlias: string;
  target: { environment: "sandbox"; disposable: true; name: string }; adapter: DisposableProviderProbeAdapter<TObject>; now?: Date;
}): Promise<ProviderCredentialProbeResult> {
  if (input.metadata.environment === "production") throw new Error("Provider credential probes are deny-listed for production credentials");
  const admission = admitProviderCredential({ metadata: input.metadata, capabilityAlias: input.capabilityAlias, environment: input.target.environment, now: input.now });
  if (!admission.admitted) throw new Error(`${admission.code}: owner=${admission.owner}; action=${admission.action}`);
  if (admission.capability.access !== "mutation") throw new Error(`Capability ${input.capabilityAlias} is read-only and cannot authorize a write probe`);
  let createdId: string | null = null;
  try {
    const created = await input.adapter.create({ name: input.target.name }); createdId = created.id;
    const readback = await input.adapter.read(created.id);
    if (!readback || readback.id !== created.id) throw new Error("Exact write probe create readback failed");
    await input.adapter.remove(created.id);
    if (await input.adapter.read(created.id) !== null) throw new Error("Exact write probe cleanup readback failed");
    createdId = null;
    return { capabilityAlias: input.capabilityAlias, createdId: created.id, createReadback: "verified", cleanupReadback: "verified_absent" };
  } finally { if (createdId) await input.adapter.remove(createdId).catch(() => undefined); }
}
