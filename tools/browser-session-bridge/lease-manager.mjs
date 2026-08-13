import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
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
      ) {
        return [key, "[REDACTED]"];
      }
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

  constructor({ stateRoot, driverFactory, now = () => Date.now(), assertIsolation = assertIsolatedRuntime }) {
    this.#stateRoot = path.resolve(required(stateRoot, "stateRoot"));
    this.#driverFactory = driverFactory;
    this.#now = now;
    this.#assertIsolation = assertIsolation;
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
    const driver = await this.#driverFactory({
      cdpHost: LOOPBACK_HOST,
      issueId,
      leaseId,
      profileDir,
    });
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
    return { leaseId, controlId, issueId, contractVersion: 1 };
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
      await rm(lease.profileDir, { recursive: true, force: true });
    }
    let profileDeleted = false;
    try {
      await access(lease.profileDir);
    } catch (error) {
      if (error?.code === "ENOENT") profileDeleted = true;
      else throw error;
    }
    lease.status = "terminated";
    this.#leases.delete(leaseId);
    return { leaseId, issueId: lease.issueId, reason, profileDeleted, accessRevoked: true };
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
    return {
      leaseId: lease.leaseId,
      issueId: lease.issueId,
      controllerAgentId: lease.controllerAgentId,
      status: lease.status,
      createdAt: new Date(lease.createdAtMs).toISOString(),
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      controlAttached: Boolean(lease.control),
      captures: { ...lease.captures },
      contractVersion: 1,
    };
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
