import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserLeaseManager,
  assertIsolatedRuntime,
  browserRuntimeContract,
  redactCapture,
} from "./lease-manager.mjs";

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

async function fixture({ now = () => 1_000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-browser-lease-test-"));
  const drivers = [];
  const manager = new BrowserLeaseManager({
    stateRoot: root,
    now,
    assertIsolation: () => {},
    driverFactory: async () => {
      const driver = fakeDriver();
      drivers.push(driver);
      return driver;
    },
  });
  return { manager, drivers };
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

test("idle expiry revokes access and deletes the profile", async () => {
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

test("explicit termination revokes access and reads profile deletion back", async () => {
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
