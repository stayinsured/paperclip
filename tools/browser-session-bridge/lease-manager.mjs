import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SEALED_SLOT_DIRECTORY = "sealed-hubspot-sandbox";
const SEALED_SLOT_METADATA = "policy.json";
const SEALED_PROFILE_DIRECTORY = "profile";
const SEALED_RETENTION_MODE = "retain_until_owner_purge";

export const HUBSPOT_SANDBOX_PORTAL_ID = "148038858";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function safeIssueSlug(issueId) {
  return required(issueId, "issueId").replace(/[^A-Za-z0-9-]/g, "-").slice(0, 80);
}

export function assertIsolatedRuntime(env = process.env) {
  if (env.PAPERCLIP_BROWSER_BRIDGE_ISOLATED_RUNTIME !== "1") {
    throw new Error(
      "Refusing to create a browser lease outside an attested isolated runtime; " +
        "set PAPERCLIP_BROWSER_BRIDGE_ISOLATED_RUNTIME=1 only in a runtime isolated from agent host files",
    );
  }
}

export function redactCapture(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactCapture);
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalized = key.toLowerCase();
      if (
        normalized.includes("authorization") ||
        normalized.includes("cookie") ||
        normalized.includes("token") ||
        normalized.includes("secret") ||
        normalized.includes("password")
      ) return [key, "[REDACTED]"];
      if (normalized === "url" && typeof entry === "string") {
        try {
          const url = new URL(entry);
          url.search = "";
          url.hash = "";
          return [key, url.toString()];
        } catch {
          return [key, "[REDACTED INVALID URL]"];
        }
      }
      return [key, redactCapture(entry)];
    }),
  );
}

export class BrowserLeaseManager {
  #leases = new Map();
  #now;
  #driverFactory;
  #stateRoot;
  #assertIsolation;
  #identityVerifier;
  #ownerVerifier;
  #sessionProbe;
  #sealedSlot;
  #activeSealedLeaseId = null;

  constructor({
    stateRoot,
    driverFactory,
    now = () => Date.now(),
    assertIsolation = assertIsolatedRuntime,
    identityVerifier = async () => false,
    ownerVerifier = async () => false,
    sessionProbe = async () => false,
  }) {
    this.#stateRoot = path.resolve(required(stateRoot, "stateRoot"));
    this.#driverFactory = driverFactory;
    this.#now = now;
    this.#assertIsolation = assertIsolation;
    this.#identityVerifier = identityVerifier;
    this.#ownerVerifier = ownerVerifier;
    this.#sessionProbe = sessionProbe;
  }

  async create({ issueId, controllerAgentId, idleMs = DEFAULT_IDLE_MS, ttlMs = DEFAULT_TTL_MS }) {
    this.#assertIsolation();
    required(controllerAgentId, "controllerAgentId");
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0) throw new Error("idleMs must be a positive integer");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive integer");
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const leaseId = randomUUID();
    const profileDir = await mkdtemp(path.join(this.#stateRoot, `${safeIssueSlug(issueId)}-${leaseId}-`));
    const createdAtMs = this.#now();
    const driver = await this.#driverFactory({ cdpHost: LOOPBACK_HOST, issueId, leaseId, profileDir });
    const lease = {
      leaseId,
      issueId,
      controllerAgentId,
      createdAtMs,
      expiresAtMs: createdAtMs + ttlMs,
      lastActivityMs: createdAtMs,
      idleMs,
      profileDir,
      driver,
      control: null,
      status: "ready",
      captures: { console: false, network: false, screenshots: false },
    };
    this.#leases.set(leaseId, lease);
    await writeFile(
      path.join(profileDir, ".paperclip-browser-lease"),
      JSON.stringify({ leaseId, issueId, createdAt: new Date(createdAtMs).toISOString() }),
      { mode: 0o600 },
    );
    return this.#publicLease(lease);
  }

  async provisionSealedProfile({ ownerIdentity, binding, retentionPolicy }) {
    this.#assertIsolation();
    const normalizedBinding = this.#normalizeSealedBinding(binding);
    const normalizedPolicy = this.#normalizeRetentionPolicy(retentionPolicy);
    await this.#assertOwner({ action: "provision", ownerIdentity, policy: normalizedPolicy });
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const existing = await this.#loadSealedSlot({ allowMissing: true });
    if (existing) {
      if (
        JSON.stringify(existing.binding) !== JSON.stringify(normalizedBinding) ||
        JSON.stringify(existing.retentionPolicy) !== JSON.stringify(normalizedPolicy)
      ) throw new Error("A different sealed browser profile slot is already provisioned");
      return this.#publicSealedSlot(existing);
    }
    const slotDir = this.#sealedSlotDirectory();
    const profileDir = path.join(slotDir, SEALED_PROFILE_DIRECTORY);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const slot = {
      schemaVersion: 1,
      provider: "hubspot",
      environment: "sandbox",
      binding: normalizedBinding,
      retentionPolicy: normalizedPolicy,
      createdAt: new Date(this.#now()).toISOString(),
      slotDir,
      profileDir,
    };
    await writeFile(
      path.join(slotDir, SEALED_SLOT_METADATA),
      JSON.stringify({
        schemaVersion: slot.schemaVersion,
        provider: slot.provider,
        environment: slot.environment,
        binding: slot.binding,
        retentionPolicy: slot.retentionPolicy,
        createdAt: slot.createdAt,
      }),
      { mode: 0o600, flag: "wx" },
    );
    this.#sealedSlot = slot;
    return this.#publicSealedSlot(slot);
  }

  async createSealed({ identity, idleMs = DEFAULT_IDLE_MS, ttlMs = DEFAULT_TTL_MS }) {
    this.#assertIsolation();
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0) throw new Error("idleMs must be a positive integer");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive integer");
    const slot = await this.#loadSealedSlot();
    await this.#assertSealedIdentity(identity, slot);
    if (this.#activeSealedLeaseId) throw new Error("Sealed browser profile already has an active lease");
    const leaseId = randomUUID();
    this.#activeSealedLeaseId = leaseId;
    const createdAtMs = this.#now();
    let driver;
    try {
      driver = await this.#driverFactory({
        cdpHost: LOOPBACK_HOST,
        issueId: identity.issueId,
        leaseId,
        profileDir: slot.profileDir,
        profileMode: "sealed",
      });
    } catch (error) {
      if (this.#activeSealedLeaseId === leaseId) this.#activeSealedLeaseId = null;
      throw error;
    }
    let sessionValid = false;
    try {
      sessionValid =
        (await this.#sessionProbe({
          driver,
          provider: slot.provider,
          environment: slot.environment,
          portalId: slot.binding.portalId,
        })) === true;
    } catch {
      sessionValid = false;
    }
    const lease = {
      leaseId,
      issueId: identity.issueId,
      controllerAgentId: identity.agentId,
      createdAtMs,
      expiresAtMs: createdAtMs + ttlMs,
      lastActivityMs: createdAtMs,
      idleMs,
      profileDir: slot.profileDir,
      driver,
      control: null,
      status: "ready",
      captures: { console: false, network: false, screenshots: false },
      retainedProfile: true,
      supervisedLoginRequired: !sessionValid,
    };
    this.#leases.set(leaseId, lease);
    this.#activeSealedLeaseId = leaseId;
    return this.#publicLease(lease);
  }

  async readSealedProfile({ ownerIdentity }) {
    const slot = await this.#loadSealedSlot();
    await this.#assertOwner({ action: "read", ownerIdentity, policy: slot.retentionPolicy });
    return this.#publicSealedSlot(slot);
  }

  async authorizeSealedProfileIssues({ ownerIdentity, authorizedIssueIds }) {
    this.#assertIsolation();
    const slot = await this.#loadSealedSlot();
    await this.#assertOwner({
      action: "authorize_issues",
      ownerIdentity,
      policy: slot.retentionPolicy,
    });
    const binding = this.#normalizeSealedBinding({
      ...slot.binding,
      authorizedIssueIds,
    });
    const nextSlot = { ...slot, binding };
    const temporaryMetadata = path.join(slot.slotDir, ".policy-" + randomUUID() + ".tmp");

    try {
      await writeFile(
        temporaryMetadata,
        JSON.stringify(this.#storedSealedSlot(nextSlot)),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporaryMetadata, path.join(slot.slotDir, SEALED_SLOT_METADATA));
    } finally {
      await rm(temporaryMetadata, { force: true });
    }

    this.#sealedSlot = nextSlot;
    return this.#publicSealedSlot(nextSlot);
  }

  async purgeSealedProfile({ ownerIdentity }) {
    this.#assertIsolation();
    const slot = await this.#loadSealedSlot();
    await this.#assertOwner({ action: "purge", ownerIdentity, policy: slot.retentionPolicy });
    if (this.#activeSealedLeaseId) {
      await this.terminate({ leaseId: this.#activeSealedLeaseId, reason: "owner_purge" });
    }
    await rm(slot.slotDir, { recursive: true, force: true });
    const profileEntries = await this.#readProfileEntryCount(slot.profileDir);
    this.#sealedSlot = null;
    return {
      slotPresent: false,
      profileDeleted: profileEntries === 0,
      profileEntries,
      accessRevoked: true,
      contractVersion: 2,
    };
  }

  async shutdown({ reason = "broker_shutdown" } = {}) {
    const results = [];
    for (const lease of [...this.#leases.values()]) {
      results.push(await this.terminate({ leaseId: lease.leaseId, reason }));
    }
    return results;
  }

  get(leaseId) {
    const lease = this.#leases.get(required(leaseId, "leaseId"));
    if (!lease) throw new Error("Unknown or revoked browser lease");
    return lease;
  }

  async attach({ leaseId, issueId, agentId }) {
    const lease = this.get(leaseId);
    await this.#assertUsable(lease);
    if (issueId !== lease.issueId) throw new Error("Browser lease belongs to a different issue");
    if (agentId !== lease.controllerAgentId) throw new Error("Agent is not authorized for this browser lease");
    if (lease.control) throw new Error("Browser lease already has an active controller");
    const controlId = randomUUID();
    lease.control = { controlId, agentId };
    lease.lastActivityMs = this.#now();
    await lease.driver.attach();
    return { leaseId, controlId, issueId, contractVersion: lease.retainedProfile ? 2 : 1 };
  }

  async detach({ leaseId, controlId }) {
    const lease = this.get(leaseId);
    this.#assertControl(lease, controlId);
    await lease.driver.detach();
    lease.control = null;
    lease.lastActivityMs = this.#now();
    return this.#publicLease(lease);
  }

  async command({ leaseId, controlId, name, payload = {} }) {
    const lease = this.get(leaseId);
    await this.#assertUsable(lease);
    this.#assertControl(lease, controlId);
    lease.lastActivityMs = this.#now();
    if (name === "capture.configure") {
      for (const key of ["console", "network", "screenshots"]) {
        if (payload[key] !== undefined) lease.captures[key] = payload[key] === true;
      }
      await lease.driver.configureCaptures({ ...lease.captures });
      return { captures: { ...lease.captures } };
    }
    const result = await lease.driver.command(name, payload, { captures: { ...lease.captures } });
    return redactCapture(result);
  }

  async terminate({ leaseId, reason = "explicit" }) {
    const lease = this.get(leaseId);
    lease.status = "terminating";
    lease.control = null;
    try {
      await lease.driver.close();
    } finally {
      if (!lease.retainedProfile) await rm(lease.profileDir, { recursive: true, force: true });
    }
    const profileDeleted = lease.retainedProfile ? false : (await this.#readProfileEntryCount(lease.profileDir)) === 0;
    lease.status = "terminated";
    this.#leases.delete(leaseId);
    if (this.#activeSealedLeaseId === leaseId) this.#activeSealedLeaseId = null;
    const result = { leaseId, issueId: lease.issueId, reason, profileDeleted, accessRevoked: true };
    if (lease.retainedProfile) result.profileRetained = true;
    return result;
  }

  async sweepExpired() {
    const now = this.#now();
    const results = [];
    for (const lease of [...this.#leases.values()]) {
      const reason = now >= lease.expiresAtMs ? "ttl_expired" : now - lease.lastActivityMs >= lease.idleMs ? "idle_expired" : null;
      if (reason) results.push(await this.terminate({ leaseId: lease.leaseId, reason }));
    }
    return results;
  }

  #assertControl(lease, controlId) {
    if (!lease.control || lease.control.controlId !== controlId) {
      throw new Error("Browser control is detached, expired, or owned by another controller");
    }
  }

  async #assertUsable(lease) {
    const now = this.#now();
    if (now >= lease.expiresAtMs || now - lease.lastActivityMs >= lease.idleMs) {
      await this.terminate({
        leaseId: lease.leaseId,
        reason: now >= lease.expiresAtMs ? "ttl_expired" : "idle_expired",
      });
      throw new Error("Browser lease expired and was revoked");
    }
    if (lease.status !== "ready") throw new Error("Browser lease is not ready");
  }

  #publicLease(lease) {
    const publicLease = {
      leaseId: lease.leaseId,
      issueId: lease.issueId,
      controllerAgentId: lease.controllerAgentId,
      status: lease.status,
      createdAt: new Date(lease.createdAtMs).toISOString(),
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      controlAttached: Boolean(lease.control),
      captures: { ...lease.captures },
      contractVersion: lease.retainedProfile ? 2 : 1,
    };
    if (lease.retainedProfile) {
      publicLease.profileRetained = true;
      publicLease.supervisedLoginRequired = lease.supervisedLoginRequired;
    }
    return publicLease;
  }

  #normalizeSealedBinding(binding) {
    const companyId = required(binding?.companyId, "binding.companyId");
    const portalId = required(binding?.portalId, "binding.portalId");
    if (portalId !== HUBSPOT_SANDBOX_PORTAL_ID) {
      throw new Error("Sealed browser profiles are restricted to the approved HubSpot sandbox portal");
    }
    const authorizedIssueIds = [...new Set(binding?.authorizedIssueIds ?? [])]
      .map((issueId) => required(issueId, "binding.authorizedIssueIds[]"))
      .sort();
    if (authorizedIssueIds.length === 0) throw new Error("binding.authorizedIssueIds is required");
    return {
      companyId,
      portalId,
      principalId: required(binding?.principalId, "binding.principalId"),
      controllerAgentId: required(binding?.controllerAgentId, "binding.controllerAgentId"),
      authorizedIssueIds,
    };
  }

  #normalizeRetentionPolicy(retentionPolicy) {
    if (retentionPolicy?.mode !== SEALED_RETENTION_MODE) {
      throw new Error(`retentionPolicy.mode must be ${SEALED_RETENTION_MODE}`);
    }
    return { mode: SEALED_RETENTION_MODE, ownerId: required(retentionPolicy?.ownerId, "retentionPolicy.ownerId") };
  }

  async #assertOwner({ action, ownerIdentity, policy }) {
    if (ownerIdentity?.ownerId !== policy.ownerId) {
      throw new Error("Owner identity is not authorized for sealed profile access");
    }
    if ((await this.#ownerVerifier({ action, ownerIdentity, ownerId: policy.ownerId })) !== true) {
      throw new Error("Owner identity is not authorized for sealed profile access");
    }
  }

  async #assertSealedIdentity(identity, slot) {
    const binding = slot.binding;
    const exactMatch =
      identity?.companyId === binding.companyId &&
      identity?.portalId === binding.portalId &&
      identity?.principalId === binding.principalId &&
      identity?.agentId === binding.controllerAgentId &&
      binding.authorizedIssueIds.includes(identity?.issueId);
    if (!exactMatch || (await this.#identityVerifier({ identity, binding })) !== true) {
      throw new Error("Browser profile identity is not authorized");
    }
  }

  async #loadSealedSlot({ allowMissing = false } = {}) {
    if (this.#sealedSlot) return this.#sealedSlot;
    const slotDir = this.#sealedSlotDirectory();
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(slotDir, SEALED_SLOT_METADATA), "utf8"));
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return null;
      if (error?.code === "ENOENT") throw new Error("No sealed browser profile slot is provisioned");
      throw new Error("Sealed browser profile metadata is invalid", { cause: error });
    }
    if (metadata?.schemaVersion !== 1 || metadata?.provider !== "hubspot" || metadata?.environment !== "sandbox") {
      throw new Error("Sealed browser profile metadata is invalid");
    }
    const binding = this.#normalizeSealedBinding(metadata.binding);
    const retentionPolicy = this.#normalizeRetentionPolicy(metadata.retentionPolicy);
    const profileDir = path.join(slotDir, SEALED_PROFILE_DIRECTORY);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    this.#sealedSlot = { ...metadata, binding, retentionPolicy, slotDir, profileDir };
    return this.#sealedSlot;
  }

  #sealedSlotDirectory() {
    return path.join(this.#stateRoot, SEALED_SLOT_DIRECTORY);
  }

  #storedSealedSlot(slot) {
    return {
      schemaVersion: slot.schemaVersion,
      provider: slot.provider,
      environment: slot.environment,
      binding: slot.binding,
      retentionPolicy: slot.retentionPolicy,
      createdAt: slot.createdAt,
    };
  }

  #publicSealedSlot(slot) {
    return {
      slotPresent: true,
      provider: slot.provider,
      environment: slot.environment,
      portalId: slot.binding.portalId,
      retained: true,
      activeLease: Boolean(this.#activeSealedLeaseId),
      contractVersion: 2,
    };
  }

  async #readProfileEntryCount(profileDir) {
    try {
      return (await readdir(profileDir)).length;
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
  }
}

export const browserRuntimeContract = Object.freeze({
  cdpHost: LOOPBACK_HOST,
  controlCommands: Object.freeze([
    "observe",
    "navigate",
    "click",
    "fill",
    "keypress",
    "capture.screenshot",
    "capture.readConsole",
    "capture.readNetwork",
    "capture.configure",
  ]),
});
