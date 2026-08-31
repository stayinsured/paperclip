# Constrained ClickUp projection

This module implements the release-1 contract for one explicitly configured
Paperclip project to one explicitly configured ClickUp list. Paperclip owns
identity and execution state after a link exists. The module never infers a
list, status, custom field, or assignee from a display name.

## Current activation state

The activation is fail-closed and requires:

- one exact workspace, space, and list ID;
- exact `to do`, `in progress`, and `done` status IDs;
- the exact native assignee ID and a managed secret reference;
- an accepted configuration revision whose fingerprint matches runtime;
- a current list-scoped identity/scope proof bound to that fingerprint; and
- the separately approved external-write switch.

Reverse intake and managed custom fields are not approved for this rollout.

`backlog`, `todo`, and `blocked` map to `to do`; `in_progress` and
`in_review` map to `in progress`; `done` and `cancelled` map to `done`.
`complete` is readable provider context but is never an owned projection target.

## Projection boundary

The projection owns the `[STA-NNNN] title`, three-state status, one native
assignee, native estimate and due date, and one marker-bounded description
block. The block carries the Paperclip URL and correlation value, exact
Paperclip status, owner label, planning and acceptance summaries, blockers, and
forecast source/revision. Text outside the managed block is preserved exactly.

Forecast metadata is accepted only from the strict provisioned-plan format or
the explicit bootstrap `## Planning metadata` format. The upper bound is
converted at eight hours per person-day and rounded upward to four hours.
Missing or malformed estimate, due date, or revision metadata produces one
stable visible exception and no provider write.

Comments, attachments, watchers, deletion, arbitrary descriptions, list moves,
universal assignment synchronization, customer data, and unknown fields have no
port in the module.

## Reliability and conflicts

The task-link table enforces one active mapping per company/issue and per
company/list/task. Before any create, the synchronizer reads the marker-bounded correlation value.
An ambiguous create is reconciled through that identity before
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
