# SDLC workflow observability runbook

Owner: DevOps Engineer  
Issue: STA-2785  
Grafana dashboard: https://stayinsured.grafana.net/d/stay-sdlc-workflow/stay-sdlc-workflow-observability  
Grafana folder UID: `stay-sdlc`  
Loki datasource UID: `grafanacloud-logs`

## Signal contract

SDLC lifecycle events use the Loki stream labels `app=paperclip-sdlc-workflow`,
`service_name=paperclip-sdlc-workflow`, and `environment=<test|production>`.
The JSON event body is schema version 1 and contains only these fields:

- `event`, `occurredAt`, `companyId`, `issueId`, `phase`, `riskClass`
- `correlationId`, `actorRunId`
- optional `provider`, `op`, `outcome`, and safe `errorClass`
- optional bounded numeric `durationMs`, `mismatchAgeSeconds`, and `retryCount`

The runtime must never emit issue titles/descriptions, comments, document bodies,
request bodies, customer identifiers, provider response payloads, raw exceptions,
stack traces, credentials, tokens, or DSNs. Unknown fields are discarded; unsafe
identifiers and token-like values fail validation instead of being partially sent.

The event taxonomy is defined in
`server/src/services/sdlc-observability.ts`. Append-only evidence records emit
classification, DoR, gate, provisioning, activation, reconciliation, drift,
emergency, waiver, and closure events. Guard denials emit
`lifecycle_transition_forbidden` without copying the rejected request.

## Runtime configuration

All values are operator-injected. Keep real values out of git, Paperclip issue
comments, and documents.

```text
PAPERCLIP_SDLC_ENVIRONMENT=test
PAPERCLIP_SDLC_LOKI_URL=<Grafana Loki base or push URL>
PAPERCLIP_SDLC_LOKI_USER=<tenant id>
PAPERCLIP_SDLC_LOKI_TOKEN=<secret ref>
PAPERCLIP_SDLC_SENTRY_DSN=<approved project DSN>
```

Loki and Sentry delivery are best-effort and never fail a lifecycle mutation.
Local structured logging continues when a sink is unavailable. Sentry receives
only explicitly classified failure events and the same allowlisted correlation
fields; raw `Error` objects are never accepted by this interface.

## Dashboard and alert rules

Dashboard UID `stay-sdlc-workflow` has six panels: total events, forbidden
transitions, provider failures, drift older than 15 minutes, events by lifecycle
type, and latest safe events. Refresh is 30 seconds and the default range is 24
hours.

Grafana folder `stay-sdlc`, rule group `SDLC workflow`:

| Rule UID | Threshold | Severity | Owner / receiver |
| --- | --- | --- | --- |
| `stay-sdlc-forbidden` | any forbidden transition in 5m | critical | DevOps Engineer / Slack eng alerts test |
| `stay-sdlc-stale-drift` | any drift with `mismatchAgeSeconds >= 900` in 5m | warning | DevOps Engineer / Slack eng alerts test |
| `stay-sdlc-provider-failure` | any provider outage with `retryCount >= 3` in 15m | warning | DevOps Engineer / Slack eng alerts test |
| `stay-sdlc-scope-violation` | any scope violation in 5m | critical | DevOps Engineer / Slack eng alerts test |
| `stay-sdlc-final-docs` | any failed DoD classified `sdlc_final_documentation_missing` in 5m | warning | DevOps Engineer / Slack eng alerts test |

All rules use `noDataState=OK`, `execErrState=Error`, carry
`owner=devops-engineer`, and route directly to the non-production contact point
`Slack eng alerts test`.

## Synthetic verification

On 2026-08-31 at 14:23:35 UTC, STA-2785 emitted two test events:

- `synthetic:STA-2785:success:v1` — `lifecycle_gate_decided`, outcome `success`
- `synthetic:STA-2785:failure:v1` — `lifecycle_provider_outage`, safe error class
  `synthetic_provider_unavailable`, `retryCount=3`

Authoritative readback query and window:

```logql
{app="paperclip-sdlc-workflow", environment="test"}
| json
| correlationId=~"synthetic:STA-2785:.*:v1"
```

Window: 2026-08-31T14:22:00Z through 2026-08-31T14:25:00Z. Loki returned
exactly two lines. Inspecting the returned labels and parsed JSON showed only the
allowlisted schema fields and no secret- or customer-bearing fields.

## Triage

1. Open dashboard UID `stay-sdlc-workflow`; select the alert environment.
2. Copy `companyId`, `issueId`, and `correlationId` from the event. Do not paste
   the full log line into an issue.
3. Read the Paperclip issue/evidence registry for the lifecycle phase and owner.
4. For provider drift/outage, read the provider mapping and last readback. Paperclip
   remains authoritative; do not repair state from ClickUp or another mirror.
5. For a forbidden transition or scope violation, preserve the guard result and
   escalate to the CTO. Do not bypass the gate.
6. For Sentry, search the approved project by `correlationId`. Treat absence as
   inconclusive until the DSN binding and environment are verified.
7. Post only a compact incident receipt: time window, event class, safe correlation
   IDs, affected phase/provider, action, and result.

## Recovery and rollback

- If Loki or Sentry delivery fails, keep lifecycle enforcement active; the sink is
  best-effort. Repair the binding and replay only an explicitly synthetic event.
- To stop non-production export, remove the task-scoped sink variables and restart
  the runtime. This does not change lifecycle state.
- A noisy test alert may be paused while its query is corrected. Do not mute or
  reroute production alerts without a tracked operator decision.
- Roll back code by reverting the STA-2785 observability commit; evidence registry
  writes and lifecycle guards remain intact because telemetry is downstream.

## Sentry target gate

The verified Sentry organization is `stay-ki`. As of 2026-08-31 it has no
Paperclip/SDLC project. Do not send control-plane events to `admin-panel`, `bff`,
`hfs`, `ico`, or another product project by inference. Bind
`PAPERCLIP_SDLC_SENTRY_DSN` only after the Board chooses or provisions the exact
project through STA-2785 interaction `a2c35761-6cfa-457f-a1dc-e65f1d4e6ffb`.
