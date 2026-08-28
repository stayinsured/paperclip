# Stay Operational Workflows

Company-scoped governed Outline, ClickUp, and Sentry/Slack workflows.

ClickUp has a fail-closed Paperclip-authoritative activation path restricted to
workspace `90151122957` and list `901511200089`, using only the official
`https://api.clickup.com/api/v2` base. It creates, updates, and closes
one correlated task per Paperclip issue, then reconciles native parent and blocker
dependency relationships from authoritative readback. Credentials remain managed
secret references resolved only at request time; a configuration never carries a
token value. Outline also has an approved, fail-closed activation path: the guarded publisher is connected to runtime reconciliation
behind the exact board-approved gates (accepted destination configuration
fingerprint, current per-collection writer proofs, all external-write switches
on, and a host-bound MCP runtime). A config without the approved activation
payload stays structurally shadow with zero provider writes. The Sentry pilot
keeps a separate fail-closed activation path for read-only polling and one-way
Slack notifications. The currently accepted pilot policies authorize zero
polling and zero Slack messages, so installation alone is inert.

## Runtime model

- A five-minute scheduled job is the authoritative reconciliation path. Active
  ClickUp configurations scan the complete project, project each issue through a
  stable correlation field, verify create/update/relationship writes by readback,
  and repair or surface remote drift without mutating Paperclip. Issue events are
  latency hints and run the same idempotent reconciliation.
- Active Outline publishing uses the host-managed `outline` profile, bound from
  company plugin config at `outline.connectionId`; the worker never receives
  the connection credential or a generic MCP invocation surface.
- Issue-created and issue-updated events are latency hints. Event payloads are
  ignored; the worker reads only allowlisted issue identity/status columns.
- Each candidate gets a SHA-256 operation key over company, module, source
  identity, source version, and policy version.
- A unique company/module/operation-key constraint plus an expiring lease
  absorbs event/schedule overlap and process restarts.
- The terminal redacted ledger receipt is committed before the cursor moves.
  A crash between those writes safely re-reads the candidate and advances the
  cursor without recreating the operation.
- Ambiguous timeout enters reconciling, 429/5xx uses bounded exponential retry,
  invalid schema and revoked credentials fail closed, and every failure creates
  one company-scoped visible exception.

Plugin-owned tables cover project configuration, operations, mappings, cursors,
exceptions, and reconciliation reports. Raw provider payloads, request bodies,
credentials, issue titles/descriptions, and customer fields have no storage
column.

## Company/project configuration

Configuration mutation is board-only:

    POST /api/plugins/<installed-plugin-id>/api/config
    Content-Type: application/json

    {
      "companyId": "<company UUID>",
      "projectId": "<project UUID>",
      "module": "outline",
      "enabled": true,
      "readOnly": true,
      "destinationEnabled": false,
      "destinationKey": "digital/architecture",
      "sourceVersion": "paperclip-v1",
      "policyVersion": "shadow-v1",
      "maxAttempts": 5,
      "baseDelayMs": 1000,
      "maxDelayMs": 300000,
      "overlapSeconds": 300,
      "batchSize": 200
    }

Valid modules are outline, clickup, and sentry_slack. Each
company/project/module row has independent enabled, readOnly,
destinationEnabled, and destinationKey switches. Sentry/Slack rows reject
readOnly false or destinationEnabled true. A ClickUp row may activate only with
`destinationKey` equal to list `901511200089` and a `clickUpActivation` payload
whose exact destination fingerprint, unexpired list-scoped read/write proof,
dependency endpoint proof, managed secret identity, and outer switches all match.
Reverse ClickUp intake is rejected. An outline row may activate only by also
carrying the approved `outlineActivation` payload (exact
destination configuration plus its accepted authorization); the payload is
validated at upsert time and re-validated on every reconciliation. Kill switch:
upsert the row with `enabled: false` (or the shadow switch combination) — the
payload and all durable state survive, and reconciliation performs zero
provider writes.

## Operator routes

- GET /api/plugins/<id>/api/report?companyId=<uuid> returns the inspectable
  shadow report, open redacted exceptions, module state, operation counts, and
  recent reconciliation runs.
- POST /api/plugins/<id>/api/reconcile with a companyId body starts a
  board-authorized manual company reconciliation.
- POST /api/plugins/<id>/api/operations/<operation-id>/replay with a companyId
  body replays within the same deterministic identity. Completed operations
  remain no-ops; bounded-attempt operations fail closed.

The host resolves and authorizes company scope before worker dispatch. Every SQL
read/write repeats that company predicate.

## Governed Sentry pilot

The Sentry path polls every five minutes with a ten-minute overlap and a daily
24-hour backscan. Provider `Link` cursors are persisted only after every issue on
the page is mapped to a stable company/org/project/Sentry-issue identity. Restart,
overlap, replay, and recurrence therefore reuse the same Paperclip triage issue.

The worker installs one managed, non-executing triage identity and the
`sentry-triage-proposal` skill. A valid proposal is stored as immutable revisioned
JSON in the triage issue's `remediation-proposal` document. The plugin creates a
board-only confirmation targeting that exact revision. A semantic edit creates a
new revision and a new confirmation; acceptance of an older revision cannot
create remediation work. Accepted current proposals create at most one child
remediation issue and require a separately configured assignee.

Slack receives only the approved summary allowlist: sanitized title, severity and
confidence, project, first/last seen, aggregate count, confirmed aggregate impact,
and links to Paperclip and Sentry. The message has no actions. Slack cannot
approve, create work, or trigger remediation. Ambiguous delivery is never blindly
retried; rate limits use their retry window and repeated failures create a
Paperclip exception.

Operator endpoints are:

- `POST /api/plugins/<id>/api/sentry/config` — board-only, company-scoped config upsert.
- `GET /api/plugins/<id>/api/sentry/report?companyId=<uuid>` — redacted operational report.
- `POST /api/plugins/<id>/api/sentry/reconcile` — board-only manual reconciliation.

Rollback is a board-authorized config update setting both `pollingEnabled` and
`slackEnabled` to false. This stops new provider calls while retaining cursors,
dedupe mappings, notification receipts, and exception evidence. Uninstalling the
plugin also stops jobs; provider token revocation is the external hard stop.

## Failure and rollback notes

| Failure | Safe behavior |
| --- | --- |
| Lost event | Scheduled scan finds the source row. |
| Restart after ledger | Same key reads the terminal receipt; cursor catches up. |
| Overlapping runs | One expiring lease wins; the other reports a duplicate. |
| Ambiguous timeout | Correlation/Get Task readback runs before the next scheduled retry; no blind create/update replay. |
| ClickUp drift | Owned field conflicts are surfaced; hierarchy/dependency drift is repaired and read back, with Paperclip unchanged. |
| Missing ClickUp mapping | A stable exception is surfaced and the five-minute scan retries after prerequisite mirrors exist. |
| 429/5xx | The result is classified retryable and the authoritative scheduled scan retries; legacy ledger retries remain capped by maxAttempts and maxDelayMs. |
| 401/403 | Revoked-credential exception; no automatic retry. |
| Invalid schema | Redacted exception; cursor does not advance. |
| Wrong company | Route authorization and repository predicates fail closed. |

Rollback for ClickUp is a board-authorized config update setting `enabled` to
false (or restoring `readOnly: true` and `destinationEnabled: false`). This stops
new ClickUp calls while retaining identity links, redacted conflicts, and reports;
it never changes Paperclip source issues and does not delete existing ClickUp
mirrors. The external hard stop is revocation of the existing operator-held
secret. Do not copy that credential into plugin configuration or agent context.

For all modules, stop/uninstall is the broader kill switch. Plugin-owned rows
remain for audit/replay and can be retained or removed under a separately approved
data-retention operation.

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` rebuilds the worker and manifest bundles into `dist/`.
When this package is installed from a local path, Paperclip watches that rebuilt
output and reloads the plugin worker. Local installs run trusted code from this
folder on your machine.



## Install Into Paperclip

```bash
paperclipai plugin install /paperclip/instances/default/projects/bc01148d-78ea-497c-8990-943eb6a7803e/89ef5740-bb84-415a-bd7c-9b3aee544d64/_default/paperclip-control-plane/packages/plugins/stay-operational-workflows
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
