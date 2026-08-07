# Stay Operational Workflows

Company-scoped shadow foundation for governed Outline, ClickUp, and Sentry/Slack workflows.

This release performs no provider calls. It deliberately omits outbound HTTP,
secret resolution, webhooks, and UI capabilities. The database enforces
read-only modules, disabled destinations, and a zero external-write count.

## Runtime model

- A five-minute scheduled job is the authoritative reconciliation path.
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
destinationEnabled, and destinationKey switches. This release rejects
readOnly false or destinationEnabled true; enabling writes requires a future,
separately approved release and migration.

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

## Failure and rollback notes

| Failure | Safe behavior |
| --- | --- |
| Lost event | Scheduled scan finds the source row. |
| Restart after ledger | Same key reads the terminal receipt; cursor catches up. |
| Overlapping runs | One expiring lease wins; the other reports a duplicate. |
| Ambiguous timeout | No blind retry; operation waits in reconciling. |
| 429/5xx | Exponential retry is capped by maxAttempts and maxDelayMs. |
| 401/403 | Revoked-credential exception; no automatic retry. |
| Invalid schema | Redacted exception; cursor does not advance. |
| Wrong company | Route authorization and repository predicates fail closed. |

Rollback is to set each module enabled false and stop/uninstall the plugin.
Plugin-owned rows remain for audit/replay and can be retained or removed under a
separately approved data-retention operation. No source issue state is changed.

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
