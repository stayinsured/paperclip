# ADR: Plugin-managed MCP tool-profile host contract

- Date: 2026-08-20
- Status: Accepted
- Issue: STA-2447
- Unblocks: STA-2441
- Scope: non-production brokered MCP execution only

## Decision

Paperclip will expose a declarative, deny-by-default managed tool-profile binding to plugin workers. A plugin declares one identity-only managed agent, one company-config path containing the approved connection id or uid, and exact upstream MCP tool names. The worker invokes `ctx.managedToolProfiles.invoke`; it cannot provide a connection id, credential reference, token, arbitrary catalog id, or agent prompt.

For the Outline reconciliation path the approved declaration is exactly:

```ts
{
  capabilities: ["tools.profile.invoke"],
  agents: [{
    agentKey: "outline-runtime",
    displayName: "Outline Runtime",
    identityOnly: "tool_profile",
  }],
  managedToolProfiles: [{
    profileKey: "outline",
    displayName: "Outline documents",
    principalAgentKey: "outline-runtime",
    connectionConfigPath: "outline.connectionId",
    tools: ["list_documents", "create_document", "update_document"],
  }],
}
```

The stable worker call is:

```ts
await ctx.managedToolProfiles.invoke({
  companyId,
  profileKey: "outline",
  toolName: "list_documents" | "create_document" | "update_document",
  parameters,
  idempotencyKey,
  timeoutMs,
});
```

The host returns `{ receipt, result? }`. `result` is present only on a fresh successful call and has passed the existing result-content sanitizer. Replays return the durable receipt only.

## Why this is the narrowest sufficient contract

The existing tool gateway already owns connection credentials, MCP transport, policy evaluation, rate limiting, result sanitization, audit events, and the `tool_invocations` ledger. Reusing it avoids a second credential path or result store. The plugin capability only reaches its own manifest declarations; it does not confer `agents.managed`, `agents.invoke`, `http.outbound`, or `secrets.read-ref`.

The identity-only managed agent exists only because the policy engine binds profiles to agent identities. Reconciliation hardens it by revoking API keys, deleting sessions and permission grants, and blocking work/routine assignment and ordinary invocation. It has no model, prompt, skill, or generic execution lifecycle.

## Data flow and authority boundaries

1. The operator configures the approved Outline MCP connection in Paperclip and stores only its id or uid at the declared company config path.
2. The plugin worker supplies company, profile key, exact tool name, sanitized parameters, and a semantic idempotency key.
3. The host resolves the declaration and company config. Worker-selected connection ids are impossible at the RPC boundary.
4. The host requires one active enabled MCP connection and exactly one active catalog entry for every declared tool.
5. The host reconciles a profile whose default is `deny`, with three `catalog_entry` includes tied to that connection, and one binding to the identity-only agent.
6. The existing policy engine evaluates the call as actor type `plugin`; any wrong connection, wrong tool, disabled profile, disabled connection, conflicting policy, or rate limit fails closed.
7. The gateway resolves credential references internally, calls MCP, sanitizes the result, and writes the durable invocation ledger. No credential material crosses the worker boundary.
8. The SDK returns the sanitized fresh result plus the versioned receipt, or a receipt alone for deny, failure, rate limit, ambiguity, or replay.

Sources of truth are: the installed validated manifest for profile/tool membership; company plugin config for connection selection; the active MCP catalog for exact tool identity; tool profiles/policies for authorization and revocation; and `tool_invocations` for the durable receipt.

## Receipt and ambiguity contract

Receipt schema version 1 contains only:

- receipt/invocation id, company id, declared profile key
- resolved connection id and exact upstream tool name
- outcome: `succeeded`, `denied`, `failed`, `rate_limited`, or `ambiguous`
- replay flag, result hash and byte size, sanitized error code, completion time

The ledger persists argument/result hashes and redacted summaries, never the raw provider result. Plugin-profile errors persist a generic reason-coded message instead of provider error text.

A write or destructive call that fails, times out, or remains indeterminate after dispatch is `ambiguous`; the caller must reconcile with a fresh list/read before retrying a create or update. Pre-dispatch policy denial and rate limiting are not ambiguous. An idempotency replay never reconstructs provider content from storage.

## Revocation and failure behavior

- Disabling or archiving the managed profile is a kill switch. Reconciliation never reactivates it.
- Disabling the connection or removing/quarantining a declared catalog entry blocks invocation.
- A profile drifted to broad selectors or extra bindings is reconciled back to the exact catalog entries and one identity binding.
- A policy requiring approval is converted to denial for this bridge; the plugin cannot create a generic approval or agent continuation through it.
- Reusing an idempotency key with a different actor, identity, connection, tool, or argument hash is a conflict.

## Rejected alternatives

- Direct Outline token or secret-ref access: rejected because it bypasses the gateway and exposes credential authority to plugin code.
- Restricted model execution principal: unnecessary and less isolated because it wakes a generic model-backed agent and adds prompt, skill, billing, assignment, and callback lifecycle.
- `agents.invoke` or another generic agent RPC: rejected because the worker could select prompts and execution behavior unrelated to Outline.
- Arbitrary MCP tool/catalog invocation: rejected because it allows connection or tool substitution outside the reviewed declaration.
- Raw provider payload persistence: rejected; only sanitized results cross the live callback and hashes/redacted summaries are durable.
- Production activation: explicitly out of scope. This contract only enables a live non-production STA-2441 retry; production still requires its separately authorized release path.

## Acceptance and rollout

| Required evidence | Proof |
| --- | --- |
| Exact connection and three tools | Host reconciliation creates only `catalog_entry` includes for the configured connection. |
| No generic identity use | Identity hardening plus assignment, invocation, and session denial tests. |
| Durable sanitized callback | `tool_invocations` receipt and replay tests; no raw provider result column or plugin error payload. |
| Wrong connection/tool and default deny | Gateway acceptance tests. |
| Revocation/kill switch | Disabled profile remains disabled and blocks the host call. |
| Ambiguous result | Failed write returns `ambiguous` and persists only a generic reason-coded error. |

Backend may now update STA-2441 to declare the profile, store its non-production connection id/uid at `outline.connectionId`, translate its provider tool names to the three exact declared names, and replace `createOutlineRuntime` with the SDK calls above. Start with the existing kill switch off, enable only in the non-production pilot company, and use list/read reconciliation after any ambiguous create or update. No production authorization is granted by this ADR.
