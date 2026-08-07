# Constrained ClickUp projection and intake

This module implements the release-1 contract for one explicitly configured
Paperclip project to one explicitly configured ClickUp list. Paperclip owns
identity and execution state after a link exists. The module never infers a
list, status, custom field, or assignee from a display name.

## Current activation state

The worker remains shadow/read-only and has no outbound-network or issue-create
capability. The accepted pilot policy records the ClickUp list, custom fields,
principal, and effective write scope as unprovisioned. Consequently the write
and intake services in this module are deliberately unwired and their gates
reject any call without all of the following:

- one exact workspace, space, and list ID;
- exact `to do`, `in progress`, `ready for qa`, and `complete` status IDs;
- exact IDs for every projected custom field and the dedicated
  `paperclip_issue_id` correlation field;
- an accepted configuration revision whose fingerprint matches the runtime
  configuration;
- a current list-scoped identity/scope proof bound to the same fingerprint;
- write or intake switches enabled by the separately approved activation
  revision.

`in_review` always maps to the configured `ready for qa` status. A list without
that exact status is invalid; there is no downgrade. `blocked` retains the last
projected status and requires the protected blocker field. Unknown and
cancelled states create a mapping failure instead of a guessed transition.

## Projection boundary

The only projected values are title, short planning summary, status, assignee
display reference, blocker summary, acceptance summary, approved estimate, and
the stable Paperclip issue identity/URL. Estimates must arrive as structured
data from the latest accepted `plan` or `cto-refinement` revision. The upper
bound is converted at eight hours per person-day and rounded upward to four
hours. Missing estimates remain unset and set the configured estimate-needed
field.

Comments, attachments, watchers, deletion, arbitrary descriptions, list moves,
universal assignment synchronization, customer data, and unknown fields have no
port in the module.

## Reliability and conflicts

The task-link table enforces one active mapping per company/issue and per
company/list/task. Before any create, the synchronizer reads by the exact
correlation field. An ambiguous create is reconciled through that field before
retry. Replays reuse the link and projection version.

The last projected version and connector service-account identity both suppress
echoes. Reconciliation performs a three-way comparison over Paperclip-owned
fields. A ClickUp-side divergence creates a stable, visible conflict row with
allowlisted values and timestamps; it is never overwritten using last-write
wins. Deletion produces a conflict receipt and never deletes or cancels the
Paperclip issue.

Projection timing health reports p95 freshness and a stable visible exception
when oldest lag exceeds 15 minutes. The authoritative plugin job runs every five
minutes; events are latency hints only.

## Rollback and validation

Rollback is configuration-only: disable external writes first, then intake,
while retaining links, conflicts, and reconciliation evidence. Do not mass
delete either system's records.

Targeted deterministic validation:

```bash
pnpm --filter @staydigital/stay-operational-workflows test -- tests/clickup.spec.ts
```

Live ClickUp validation belongs to the separately approved QA sandbox-UAT lane.
The validator must prove the exact non-production/company identity before any
provider request and stop on a production or wrong-list mismatch.
