# Supervised browser-session bridge

This directory contains the fail-closed lease core for an issue-scoped browser
bridge. It is an operator/runtime capability, not an application feature.

The lease manager deliberately refuses to create a profile unless the runtime
sets `PAPERCLIP_BROWSER_BRIDGE_ISOLATED_RUNTIME=1`. That variable is an
attestation made by the runtime provisioner, not an option an agent should set.
The isolated runtime must prevent the assigned agent from reading the browser
profile or broker process files directly.

## Security contract

- One newly created profile directory per lease and Paperclip issue.
- Chromium CDP host is fixed to `127.0.0.1`; the broker never returns its port or
  WebSocket URL.
- The named controller must present the same issue and agent identity on attach.
- A second controller is rejected until the current controller detaches.
- Detach keeps browser state; reattach rotates the control handle.
- Idle and absolute expiry close the driver, revoke control, recursively remove
  the temporary profile, and read back `ENOENT` before reporting deletion.
- Explicit termination follows the same cleanup path.
- Screenshot, console, and network capture begin disabled. The assigned agent
  must opt into each capture type; returned structured capture data is redacted.
- Public lease metadata is allowlisted and contains no CDP address, viewer
  credential, cookie, or profile path.

## Required runtime adapter

The remaining adapter must run this core inside a dedicated runtime namespace
with:

1. headed Chromium and a fresh X display;
2. profile storage visible only to the broker/browser processes;
3. an authenticated, short-lived viewer bound to loopback and reached by the
   human through the runtime's authenticated port-forward facility;
4. a loopback or private Unix-socket broker transport exposed to the named QA
   agent as the opaque commands below;
5. identity derived from the Paperclip run credential, never from a caller-
   supplied `agentId` flag.

Do not activate on a shared host where agents and Chromium have the same OS file
identity. File modes cannot protect the profile from another process owned by
that identity.

## Human handoff

1. DevOps creates the lease for the target issue and named QA agent through the
   runtime adapter. Record only the returned `leaseId`, expiry, issue, and agent.
2. The board operator opens the viewer through the runtime's authenticated
   port-forward. Viewer credentials or URLs containing credentials are delivered
   only by that private handoff and never pasted into an issue, command log, or
   retained evidence.
3. The human completes login/MFA directly in the viewer, navigates to a neutral
   page, closes the viewer, and tells DevOps that handoff is ready. The agent
   never receives login credentials or viewer credentials.
4. DevOps enables QA attach for the already named controller. The human can
   revoke the viewer independently; this does not export browser state.

## QA tool contract

The runtime adapter should expose these names without exposing a socket or CDP
address:

```text
browserLease.attach(issueId, leaseId)
browserLease.observe(leaseId, controlId)
browserLease.navigate(leaseId, controlId, url)
browserLease.click(leaseId, controlId, selector)
browserLease.fill(leaseId, controlId, selector, value)
browserLease.keypress(leaseId, controlId, key)
browserLease.capture.configure(leaseId, controlId, console?, network?, screenshots?)
browserLease.capture.screenshot(leaseId, controlId)
browserLease.capture.readConsole(leaseId, controlId)
browserLease.capture.readNetwork(leaseId, controlId)
browserLease.detach(leaseId, controlId)
browserLease.terminate(leaseId)
```

The agent attaches with its normal Paperclip run identity. There is no supported
command that returns cookies, storage state, a profile archive, a viewer token,
or a raw CDP endpoint.

## Focused verification

```bash
node --test tools/browser-session-bridge/lease-manager.test.mjs
```

This test proves the lease/cleanup contract without starting an unsafe browser
on the shared agent host. A full acceptance smoke is valid only after the
runtime adapter provides the namespace and authenticated viewer described
above.
