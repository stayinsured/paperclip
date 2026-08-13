import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserLeaseManager,
  HUBSPOT_SANDBOX_PORTAL_ID,
  SEALED_COMPANY_AGENTS_SCOPE,
  assertIsolatedRuntime,
  browserRuntimeContract,
  redactCapture,
} from "./lease-manager.mjs";

const SEALED_BINDING = Object.freeze({
  companyId: "company-stay-digital-products",
  portalId: HUBSPOT_SANDBOX_PORTAL_ID,
  principalId: "marketing-editor",
  controllerAgentId: "named-qa-agent",
  authorizedIssueIds: ["STA-2187"],
});
const OWNER_IDENTITY = Object.freeze({ ownerId: "board-owner", attested: true });
const RETENTION_POLICY = Object.freeze({ mode: "retain_until_owner_purge", ownerId: "board-owner" });
const SEALED_IDENTITY = Object.freeze({
  companyId: SEALED_BINDING.companyId,
  portalId: SEALED_BINDING.portalId,
  principalId: SEALED_BINDING.principalId,
  agentId: SEALED_BINDING.controllerAgentId,
  issueId: "STA-2187",
  attested: true,
});

function fakeDriver(state = { value: "neutral" }) {
  return {
    state,
    attached: false,
    closed: false,
    captures: null,
    async attach() {
      this.attached = true;
    },
    async detach() {
      this.attached = false;
    },
    async configureCaptures(captures) {
      this.captures = captures;
    },
    async command(name, payload) {
      if (name === "state.set") state.value = payload.value;
      return {
        name,
        value: state.value,
        url: "https://neutral.example/path?session=do-not-retain#secret",
        headers: { authorization: "Bearer no", cookie: "sid=no", accept: "text/html" },
      };
    },
    async close() {
      this.closed = true;
    },
  };
}

async function fixture({
  now = () => 1_000,
  root,
  persistentStates = new Map(),
  sessionValid = false,
  sessionProbe,
  identityVerifier = async ({ identity }) => identity.attested === true,
  ownerVerifier = async ({ ownerIdentity }) => ownerIdentity.attested === true,
} = {}) {
  const stateRoot = root ?? (await mkdtemp(path.join(os.tmpdir(), "paperclip-browser-lease-test-")));
  const drivers = [];
  const profileDirs = [];
  const manager = new BrowserLeaseManager({
    stateRoot,
    now,
    assertIsolation: () => {},
    identityVerifier,
    ownerVerifier,
    sessionProbe: sessionProbe ?? (async () => sessionValid),
    driverFactory: async ({ profileDir }) => {
      const state = persistentStates.get(profileDir) ?? { value: "neutral" };
      persistentStates.set(profileDir, state);
      profileDirs.push(profileDir);
      const driver = fakeDriver(state);
      drivers.push(driver);
      return driver;
    },
  });
  return { manager, drivers, root: stateRoot, profileDirs, persistentStates };
}

async function provision(manager) {
  return manager.provisionSealedProfile({
    ownerIdentity: OWNER_IDENTITY,
    binding: SEALED_BINDING,
    retentionPolicy: RETENTION_POLICY,
  });
}

test("fails closed without an isolated-runtime attestation", () => {
  assert.throws(() => assertIsolatedRuntime({}), /Refusing to create a browser lease/);
  assert.doesNotThrow(() => assertIsolatedRuntime({ PAPERCLIP_BROWSER_BRIDGE_ISOLATED_RUNTIME: "1" }));
});

test("publishes only an opaque lease contract and pins CDP to loopback", async () => {
  const { manager } = await fixture();
  const lease = await manager.create({ issueId: "STA-2208", controllerAgentId: "qa-agent" });
  assert.equal(browserRuntimeContract.cdpHost, "127.0.0.1");
  assert.deepEqual(Object.keys(lease).sort(), [
    "captures",
    "contractVersion",
    "controlAttached",
    "controllerAgentId",
    "createdAt",
    "expiresAt",
    "issueId",
    "leaseId",
    "status",
  ]);
  assert.doesNotMatch(JSON.stringify(lease), /cdp|profile|cookie|token|endpoint/i);
});

test("rejects cross-issue, unauthorized, and concurrent control", async () => {
  const { manager } = await fixture();
  const lease = await manager.create({ issueId: "STA-2208", controllerAgentId: "qa-agent" });
  await assert.rejects(
    manager.attach({ leaseId: lease.leaseId, issueId: "STA-2187", agentId: "qa-agent" }),
    /different issue/,
  );
  await assert.rejects(
    manager.attach({ leaseId: lease.leaseId, issueId: "STA-2208", agentId: "other-agent" }),
    /not authorized/,
  );
  const control = await manager.attach({ leaseId: lease.leaseId, issueId: "STA-2208", agentId: "qa-agent" });
  await assert.rejects(
    manager.attach({ leaseId: lease.leaseId, issueId: "STA-2208", agentId: "qa-agent" }),
    /active controller/,
  );
  await manager.detach(control);
});

test("detach and reattach retain browser state while rotating the control handle", async () => {
  const { manager } = await fixture();
  const lease = await manager.create({ issueId: "STA-2208", controllerAgentId: "qa-agent" });
  const first = await manager.attach({ leaseId: lease.leaseId, issueId: "STA-2208", agentId: "qa-agent" });
  await manager.command({ leaseId: lease.leaseId, controlId: first.controlId, name: "state.set", payload: { value: "retained" } });
  await manager.detach(first);
  const second = await manager.attach({ leaseId: lease.leaseId, issueId: "STA-2208", agentId: "qa-agent" });
  assert.notEqual(first.controlId, second.controlId);
  const observed = await manager.command({ leaseId: lease.leaseId, controlId: second.controlId, name: "observe" });
  assert.equal(observed.value, "retained");
  assert.equal(observed.url, "https://neutral.example/path");
  assert.equal(observed.headers.authorization, "[REDACTED]");
  assert.equal(observed.headers.cookie, "[REDACTED]");
});

test("captures are opt-in", async () => {
  const { manager, drivers } = await fixture();
  const lease = await manager.create({ issueId: "STA-2208", controllerAgentId: "qa-agent" });
  const control = await manager.attach({ leaseId: lease.leaseId, issueId: "STA-2208", agentId: "qa-agent" });
  assert.deepEqual(lease.captures, { console: false, network: false, screenshots: false });
  const configured = await manager.command({
    leaseId: lease.leaseId,
    controlId: control.controlId,
    name: "capture.configure",
    payload: { console: true, network: true },
  });
  assert.deepEqual(configured.captures, { console: true, network: true, screenshots: false });
  assert.deepEqual(drivers[0].captures, configured.captures);
});

test("idle expiry revokes access and deletes an ephemeral profile", async () => {
  let now = 1_000;
  const { manager } = await fixture({ now: () => now });
  const lease = await manager.create({ issueId: "STA-2208", controllerAgentId: "qa-agent", idleMs: 100, ttlMs: 1_000 });
  now = 1_101;
  const expired = await manager.sweepExpired();
  assert.deepEqual(expired, [
    { leaseId: lease.leaseId, issueId: "STA-2208", reason: "idle_expired", profileDeleted: true, accessRevoked: true },
  ]);
  assert.throws(() => manager.get(lease.leaseId), /Unknown or revoked/);
});

test("explicit termination revokes access and reads ephemeral profile deletion back", async () => {
  const { manager, drivers } = await fixture();
  const lease = await manager.create({ issueId: "STA-2208", controllerAgentId: "qa-agent" });
  const result = await manager.terminate({ leaseId: lease.leaseId });
  assert.equal(result.profileDeleted, true);
  assert.equal(result.accessRevoked, true);
  assert.equal(drivers[0].closed, true);
});

test("capture redaction is recursive and strips URL query material", () => {
  assert.deepEqual(
    redactCapture({ url: "https://example.test/a?code=123#x", nested: { accessToken: "x", ok: true } }),
    { url: "https://example.test/a", nested: { accessToken: "[REDACTED]", ok: true } },
  );
});

test("sealed provisioning requires explicit owner policy and only permits the approved sandbox portal", async () => {
  const { manager } = await fixture();
  await assert.rejects(
    manager.provisionSealedProfile({
      ownerIdentity: OWNER_IDENTITY,
      binding: SEALED_BINDING,
      retentionPolicy: { mode: "delete_on_terminate", ownerId: OWNER_IDENTITY.ownerId },
    }),
    /retain_until_owner_purge/,
  );
  await assert.rejects(
    manager.provisionSealedProfile({
      ownerIdentity: OWNER_IDENTITY,
      binding: { ...SEALED_BINDING, portalId: "production" },
      retentionPolicy: RETENTION_POLICY,
    }),
    /approved HubSpot sandbox portal/,
  );
  const status = await provision(manager);
  assert.deepEqual(status, {
    slotPresent: true,
    provider: "hubspot",
    environment: "sandbox",
    portalId: HUBSPOT_SANDBOX_PORTAL_ID,
    retained: true,
    activeLease: false,
    contractVersion: 2,
  });
  await assert.rejects(
    manager.provisionSealedProfile({
      ownerIdentity: OWNER_IDENTITY,
      binding: { ...SEALED_BINDING, principalId: "different-principal" },
      retentionPolicy: RETENTION_POLICY,
    }),
    /different sealed browser profile slot/,
  );
});

test("owner and lease operations fail closed without broker-side identity attestation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-browser-lease-test-"));
  const manager = new BrowserLeaseManager({
    stateRoot: root,
    assertIsolation: () => {},
    driverFactory: async () => fakeDriver(),
  });
  await assert.rejects(
    manager.provisionSealedProfile({
      ownerIdentity: OWNER_IDENTITY,
      binding: SEALED_BINDING,
      retentionPolicy: RETENTION_POLICY,
    }),
    /Owner identity is not authorized/,
  );
});

test("sealed profile rejects cross-company, portal, principal, agent, issue, and concurrent lease use", async () => {
  const { manager } = await fixture();
  await provision(manager);
  for (const changed of [
    { companyId: "other-company" },
    { portalId: "other-portal" },
    { principalId: "other-principal" },
    { agentId: "other-agent" },
    { issueId: "STA-unrelated" },
    { attested: false },
  ]) {
    await assert.rejects(manager.createSealed({ identity: { ...SEALED_IDENTITY, ...changed } }), /not authorized/);
  }
  const lease = await manager.createSealed({ identity: SEALED_IDENTITY });
  await assert.rejects(manager.createSealed({ identity: SEALED_IDENTITY }), /already has an active lease/);
  assert.doesNotMatch(JSON.stringify(lease), /profileDir|principal|owner|cookie|storage|cdp/i);
});

test("company-agent scope still requires independent run-token identity verification", async () => {
  const valid = new Set([
    "token-a:run-a:agent-a:STA-A",
    "token-b:run-b:agent-b:STA-B",
  ]);
  const { manager } = await fixture({
    identityVerifier: async ({ identity }) => valid.has(
      [identity.token, identity.runId, identity.agentId, identity.issueId].join(":"),
    ),
  });
  await manager.provisionSealedProfile({
    ownerIdentity: OWNER_IDENTITY,
    binding: {
      companyId: SEALED_BINDING.companyId,
      portalId: SEALED_BINDING.portalId,
      principalId: SEALED_BINDING.principalId,
      controllerScope: SEALED_COMPANY_AGENTS_SCOPE,
      authorizedIssueIds: ["*"],
    },
    retentionPolicy: RETENTION_POLICY,
  });

  const firstIdentity = {
    companyId: SEALED_BINDING.companyId,
    portalId: SEALED_BINDING.portalId,
    principalId: SEALED_BINDING.principalId,
    agentId: "agent-a",
    issueId: "STA-A",
    runId: "run-a",
    token: "token-a",
    attested: true,
  };
  await assert.rejects(
    manager.createSealed({ identity: { ...firstIdentity, token: "spoofed" } }),
    /not authorized/,
  );
  await assert.rejects(
    manager.createSealed({ identity: { ...firstIdentity, companyId: "other-company" } }),
    /not authorized/,
  );
  const first = await manager.createSealed({ identity: firstIdentity });
  await manager.terminate({ leaseId: first.leaseId });

  const second = await manager.createSealed({
    identity: {
      ...firstIdentity,
      agentId: "agent-b",
      issueId: "STA-B",
      runId: "run-b",
      token: "token-b",
    },
  });
  assert.equal(second.controllerAgentId, "agent-b");
  assert.equal(second.issueId, "STA-B");
  await manager.terminate({ leaseId: second.leaseId });
});

test("company-agent scope requires the verified running-task wildcard", async () => {
  const { manager } = await fixture();
  await assert.rejects(
    manager.provisionSealedProfile({
      ownerIdentity: OWNER_IDENTITY,
      binding: {
        companyId: SEALED_BINDING.companyId,
        portalId: SEALED_BINDING.portalId,
        principalId: SEALED_BINDING.principalId,
        controllerScope: SEALED_COMPANY_AGENTS_SCOPE,
        authorizedIssueIds: ["STA-2187"],
      },
      retentionPolicy: RETENTION_POLICY,
    }),
    /verified running-task wildcard/,
  );
});

test("sealed profile rejects a concurrent lease while the first lease is still starting", async () => {
  let releaseProbe;
  let markProbeStarted;
  const probeStarted = new Promise((resolve) => {
    markProbeStarted = resolve;
  });
  const probeReleased = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const { manager } = await fixture({
    sessionProbe: async () => {
      markProbeStarted();
      await probeReleased;
      return true;
    },
  });
  await provision(manager);

  const firstLease = manager.createSealed({ identity: SEALED_IDENTITY });
  await probeStarted;
  await assert.rejects(
    manager.createSealed({ identity: SEALED_IDENTITY }),
    /already has an active lease/,
  );
  releaseProbe();
  const lease = await firstLease;
  await manager.terminate({ leaseId: lease.leaseId });
});

test("owner can authorize a future issue without changing the sealed identity", async () => {
  const { manager, root } = await fixture();
  await provision(manager);
  await assert.rejects(
    manager.authorizeSealedProfileIssues({
      ownerIdentity: { ownerId: "qa-agent", attested: true },
      authorizedIssueIds: ["STA-2187", "STA-2224"],
    }),
    /Owner identity is not authorized/,
  );
  await manager.authorizeSealedProfileIssues({
    ownerIdentity: OWNER_IDENTITY,
    authorizedIssueIds: ["STA-2187", "STA-2224"],
  });
  const lease = await manager.createSealed({
    identity: { ...SEALED_IDENTITY, issueId: "STA-2224" },
  });
  assert.equal(lease.issueId, "STA-2224");
  await manager.terminate({ leaseId: lease.leaseId });
  const restarted = await fixture({ root });
  const reused = await restarted.manager.createSealed({
    identity: { ...SEALED_IDENTITY, issueId: "STA-2224" },
  });
  assert.equal(reused.issueId, "STA-2224");
  await restarted.manager.terminate({ leaseId: reused.leaseId });
  await assert.rejects(
    restarted.manager.createSealed({
      identity: { ...SEALED_IDENTITY, issueId: "STA-unrelated" },
    }),
    /not authorized/,
  );
});

test("sealed expiry revokes control but retains the slot for a new authorized lease", async () => {
  let now = 1_000;
  const shared = await fixture({ now: () => now, sessionValid: true });
  await provision(shared.manager);
  const first = await shared.manager.createSealed({ identity: SEALED_IDENTITY, idleMs: 100, ttlMs: 1_000 });
  const control = await shared.manager.attach({
    leaseId: first.leaseId,
    issueId: SEALED_IDENTITY.issueId,
    agentId: SEALED_IDENTITY.agentId,
  });
  await shared.manager.command({
    leaseId: first.leaseId,
    controlId: control.controlId,
    name: "state.set",
    payload: { value: "still-valid-session" },
  });
  now = 1_101;
  const [expired] = await shared.manager.sweepExpired();
  assert.equal(expired.accessRevoked, true);
  assert.equal(expired.profileRetained, true);
  assert.equal(expired.profileDeleted, false);

  const second = await shared.manager.createSealed({ identity: SEALED_IDENTITY });
  const secondControl = await shared.manager.attach({
    leaseId: second.leaseId,
    issueId: SEALED_IDENTITY.issueId,
    agentId: SEALED_IDENTITY.agentId,
  });
  const observed = await shared.manager.command({
    leaseId: second.leaseId,
    controlId: secondControl.controlId,
    name: "observe",
  });
  assert.equal(observed.value, "still-valid-session");
});

test("broker restart closes control, preserves the slot, and reuses session state", async () => {
  const persistentStates = new Map();
  const first = await fixture({ persistentStates, sessionValid: true });
  await provision(first.manager);
  const lease = await first.manager.createSealed({ identity: SEALED_IDENTITY });
  const control = await first.manager.attach({
    leaseId: lease.leaseId,
    issueId: SEALED_IDENTITY.issueId,
    agentId: SEALED_IDENTITY.agentId,
  });
  await first.manager.command({
    leaseId: lease.leaseId,
    controlId: control.controlId,
    name: "state.set",
    payload: { value: "restart-reuse" },
  });
  const [shutdown] = await first.manager.shutdown({ reason: "broker_restart" });
  assert.equal(shutdown.accessRevoked, true);
  assert.equal(shutdown.profileRetained, true);

  const restarted = await fixture({
    root: first.root,
    persistentStates,
    sessionValid: true,
  });
  const nextLease = await restarted.manager.createSealed({ identity: SEALED_IDENTITY });
  assert.equal(nextLease.supervisedLoginRequired, false);
  const nextControl = await restarted.manager.attach({
    leaseId: nextLease.leaseId,
    issueId: SEALED_IDENTITY.issueId,
    agentId: SEALED_IDENTITY.agentId,
  });
  const observed = await restarted.manager.command({
    leaseId: nextLease.leaseId,
    controlId: nextControl.controlId,
    name: "observe",
  });
  assert.equal(observed.value, "restart-reuse");
});

test("expired or unprovable HubSpot sessions require supervised human login", async () => {
  const expired = await fixture({ sessionValid: false });
  await provision(expired.manager);
  const lease = await expired.manager.createSealed({ identity: SEALED_IDENTITY });
  assert.equal(lease.supervisedLoginRequired, true);
  assert.deepEqual(lease.captures, { console: false, network: false, screenshots: false });
});

test("only the owner can read or purge and purge returns zero-entry deletion readback", async () => {
  const { manager } = await fixture();
  await provision(manager);
  await assert.rejects(
    manager.readSealedProfile({ ownerIdentity: { ownerId: "qa-agent", attested: true } }),
    /Owner identity is not authorized/,
  );
  await assert.rejects(
    manager.purgeSealedProfile({ ownerIdentity: { ownerId: OWNER_IDENTITY.ownerId, attested: false } }),
    /Owner identity is not authorized/,
  );
  const lease = await manager.createSealed({ identity: SEALED_IDENTITY });
  const purged = await manager.purgeSealedProfile({ ownerIdentity: OWNER_IDENTITY });
  assert.deepEqual(purged, {
    slotPresent: false,
    profileDeleted: true,
    profileEntries: 0,
    accessRevoked: true,
    contractVersion: 2,
  });
  assert.throws(() => manager.get(lease.leaseId), /Unknown or revoked/);
  await assert.rejects(manager.createSealed({ identity: SEALED_IDENTITY }), /No sealed browser profile slot/);
});
