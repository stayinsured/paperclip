# Supervised browser-session bridge

This directory contains the fail-closed lease core for an issue-scoped browser
bridge. It is an operator/runtime capability, not an application feature.

The lease manager deliberately refuses to create a profile unless the runtime
sets `PAPERCLIP_BROWSER_BRIDGE_ISOLATED_RUNTIME=1`. That variable is an
attestation made by the runtime provisioner, not an option an agent should set.
The isolated runtime must prevent the assigned agent from reading the browser
profile or broker process files directly.

## Security contract

- Ephemeral leases continue to create one new profile per lease and Paperclip
  issue, then delete it on idle expiry, TTL expiry, or termination.
- Chromium CDP host is fixed to `127.0.0.1`; the broker never returns its port
  or WebSocket URL.
- The named controller must present the same issue and agent identity on attach.
- A second controller is rejected until the current controller detaches.
- Detach keeps browser state; reattach rotates the control handle.
- Screenshot, console, and network capture begin disabled. The assigned agent
  must opt into each capture type; returned structured capture data is redacted.
- Public lease metadata is allowlisted and contains no CDP address, viewer
  credential, cookie, storage state, or profile path.

## Sealed HubSpot sandbox profile

Contract version 2 adds exactly one broker-owned retained slot for HubSpot
sandbox portal `148038858`. The slot is experimental until its isolated runtime
adapter has completed the sanitized owner smoke.

Provisioning requires an attested owner identity and the explicit
`retain_until_owner_purge` policy. The immutable slot policy binds:

- the Stay Digital Products company identity;
- HubSpot provider, sandbox environment, and portal `148038858`;
- the intended Marketing/editor principal;
- one named QA agent; and
- an explicit allowlist of related Paperclip issue identities.

Company, portal, and principal bindings remain immutable. The default policy
continues to bind one named agent and an explicit issue allowlist. An owner may
instead select the explicit `company_active_agents` scope with the verified
running-task wildcard. That broader scope is valid only when the runtime adapter
independently derives and verifies company, active agent, live run, assigned issue,
and execution-run binding from the presented Paperclip run token. Caller-supplied
identity flags never satisfy this check. The retained slot still permits only one
lease/controller globally. The attested owner may atomically replace only the
issue allowlist for named-agent mode; this neither exposes nor recreates the
retained profile.

The adapter derives owner, company, issue, agent, portal, and principal claims
from authenticated broker/run context. It must not accept caller-supplied
identity flags. The core compares every claim to the sealed policy and then
requires the adapter's broker-side verifier to attest it. A mismatch has one
generic rejection response so an unauthorized caller cannot enumerate policy
details. Only one retained-slot lease may exist at a time; an in-flight lease
reservation rejects overlapping creation attempts before either can receive
control.

Idle expiry, TTL expiry, explicit lease termination, and broker shutdown revoke
browser/control access and close Chromium without deleting the slot. A clean
broker restart reloads the sealed policy and a new authorized lease reuses the
same slot. The session probe reports only whether supervised login is required:
a valid sandbox session avoids another login; an expired, failed, or
indeterminate probe falls back to the authenticated human viewer. The
authenticator remains human-held.

Only the attested retention owner can read sanitized slot status, atomically
replace the issue allowlist, or purge the slot. The adapter exposes these as
owner-only operations such as `browserLease.profile.authorizeIssues(issueIds)`;
each future task requires explicit owner authorization before reuse. Purge first
revokes an active lease, recursively deletes the slot, and
reports success only after a zero-entry deletion readback. QA has no profile
read, export, archive, mount, storage-state, cookie, or purge operation.

## Required runtime adapter

The adapter must run this core inside a dedicated runtime namespace with:

1. headed Chromium and a fresh X display;
2. profile storage visible only to the broker/browser processes;
3. an authenticated, short-lived viewer bound to loopback and reached by the
   human through the runtime's authenticated port-forward facility;
4. a loopback or private Unix-socket broker transport exposed to the named QA
   agent as opaque commands;
5. identity derived from the Paperclip run credential, never from a caller-
   supplied `agentId` flag;
6. an owner verifier separate from QA/controller authorization; and
7. a sanitized HubSpot session probe restricted to portal `148038858`.

Do not activate on a shared host where agents and Chromium have the same OS file
identity. File modes cannot protect the profile from another process owned by
that identity. Do not expose the sealed slot through a workspace mount or host
file path.

## Existing-session migration guard

The authenticated STA-2187 browser must not be terminated through the
delete-on-terminate path before its profile is sealed. Wait for the named QA
controller to detach and for the host owner to confirm the browser is no longer
being used. Then, entirely inside the isolated broker boundary:

1. revoke browser/control admission and gracefully stop Chromium;
2. atomically rename the broker-owned profile into the fixed sealed slot on the
   same broker volume; do not copy, inspect, archive, mount, or list its
   contents;
3. write the owner-approved policy metadata from privately derived broker
   identity claims, without logging paths, lease/control values, or session
   material;
4. stage the persistence source, restart the broker, and request a new
   authorized lease; and
5. accept the migration only after the sanitized session probe and reuse smoke
   pass.

If migration or evidence reporting fails, keep the stopped profile in its
broker-owned location and stop. Failure must not invoke ordinary lease cleanup
or owner purge. Purge remains a separate, explicit owner action.

## Human handoff

1. DevOps provisions the retained slot once under the explicit owner policy, or
   creates an ephemeral lease for a task that does not use retention.
2. DevOps requests a lease for the target issue and named QA agent through the
   runtime adapter. The runtime keeps lease and control references opaque.
3. If the sanitized result says supervised login is required, the board
   operator opens the viewer through the authenticated port-forward. Viewer
   credentials or credential-bearing URLs never enter issue comments, command
   logs, environment output, or retained evidence.
4. The human completes login/MFA directly in the viewer, verifies the sandbox
   portal and intended principal, closes or revokes the viewer, and signals
   readiness. The agent never receives login or viewer credentials.
5. DevOps enables QA attach for the already named controller. Viewer revocation
   and browser/control revocation remain independent of profile retention.

## QA tool contract

The runtime adapter exposes these names without exposing a socket, CDP address,
profile identifier, or host path:

```text
browserLease.attach(issueId)
browserLease.observe()
browserLease.navigate(url)
browserLease.click(selector)
browserLease.fill(selector, value)
browserLease.keypress(key)
browserLease.capture.configure(console?, network?, screenshots?)
browserLease.capture.screenshot()
browserLease.capture.readConsole()
browserLease.capture.readNetwork()
browserLease.detach()
browserLease.terminate()
```

The agent attaches with its normal Paperclip run identity. Runtime-supplied
lease/control references are not printed or retained. There is no supported
command that returns cookies, storage state, a profile archive, a viewer token,
or a raw CDP endpoint.

Owner-only operations are separate from the QA tool surface:

```text
browserLease.profile.provision(policy)
browserLease.profile.status()
browserLease.profile.purge()
```

## Focused verification

```bash
node --test tools/browser-session-bridge/lease-manager.test.mjs
```

The focused suite proves ephemeral rollback compatibility, exact sealed binding,
broker-side identity rejection, owner-scoped issue authorization, single-use
enforcement, capture defaults,
revocation with retention, broker restart reuse, supervised-login fallback, and
owner-only zero-entry purge. The isolated owner smoke must additionally prove
that QA and unrelated agents have no profile mount or host-file access and that
CDP remains loopback-only.

## Rollback

Revoke viewers/controllers, stop the broker, run the owner-only purge, verify
zero retained profile entries, and route future leases through the existing
delete-on-terminate `create` path.

## Change note

- Added an experimental owner-sealed HubSpot sandbox profile contract with
  restart reuse, fail-closed identity checks, independent access revocation,
  supervised-login fallback, owner-scoped issue reuse, and deletion readback
  (STA-2224).
