# Acceptance fixtures

Use these synthetic, sanitized cases to test classification consistency. For every fixture, populate the complete output contract; the fields below state the required outcome.

## Positive cases

### F01 — Architecture boundary changed

Input: `STA-2201` replaced a best-effort webhook path with a persisted idempotent operation ledger and reconciliation worker. A commit and restart/replay tests prove the new boundary. No matching document exists after an index lookup.

Expected:

- `classification`: `material`
- `reasonCodes`: includes `architecture_changed`
- `targetClass`: `Architecture`
- `documentKey`: `v1:architecture:external-operation-ledger`
- `proposedAction`: `create`
- `safeDraft.template`: `architecture_decision`

### F02 — Durable technical decision updates a canonical ADR

Input: `STA-2202` selected bounded polling with overlap instead of webhook-first intake because provider configuration and replay guarantees were not yet proven. The alternatives, trade-offs, and decision are recorded. `outline-adr-sentry-intake` already maps to `v1:architecture:sentry-intake`.

Expected:

- `classification`: `material`
- `reasonCodes`: includes `durable_decision`
- `targetClass`: `Architecture`
- `documentKey`: `v1:architecture:sentry-intake`
- `proposedAction`: `update`
- `existingDocumentRef`: `outline-adr-sentry-intake`
- `safeDraft.template`: `architecture_decision`

### F03 — Durable outcome metrics

Input: `STA-2203` reduced synthetic form-processing failure rate from 8.2% to 1.1% across 20,000 replayed staging requests during a 14-day comparison window. The benchmark artifact states the sample and notes that production impact is not yet proven. No matching report exists.

Expected:

- `classification`: `material`
- `reasonCodes`: includes `durable_outcome_metrics`
- `targetClass`: `Reports`
- `documentKey`: `v1:reports:form-processing-reliability`
- `proposedAction`: `create`
- `safeDraft.template`: `completed_task_outcome`

### F04 — Repeatable operator procedure

Input: `STA-2204` introduced a replay procedure for ambiguous external-write timeouts, including preconditions, deterministic lookup, stop conditions, verification, rollback, and escalation ownership. Integration tests exercise the procedure.

Expected:

- `classification`: `material`
- `reasonCodes`: includes `operator_procedure_created`
- `targetClass`: `Processes`
- `documentKey`: `v1:processes:ambiguous-write-reconciliation`
- `proposedAction`: `create`
- `safeDraft.template`: `operator_process`

### F05 — Significant delivery outcome without a metric

Input: `STA-2205` completed a company-scoped kill-switch boundary that independently disables each external integration while leaving read-only reconciliation available. Tests prove isolation and audit behavior. The stable subject has no canonical report.

Expected:

- `classification`: `material`
- `reasonCodes`: includes `significant_delivery_outcome`
- `targetClass`: `Reports`
- `documentKey`: `v1:reports:integration-kill-switch-outcome`
- `proposedAction`: `create`
- `safeDraft.template`: `completed_task_outcome`

## Negative cases

All negative cases must set `targetClass: "none"`, `proposedAction: "none"`, `safeDraft: null`, and `review.required: false`. They must contain no publish recommendation.

### F06 — Trivial change

Input: `STA-2206` corrected a spelling error in an internal log message. No behavior, contract, decision, metric, or operator procedure changed.

Expected: `not_material` with `trivial_change`.

### F07 — Routine completion

Input: `STA-2207` applied a routine patch dependency update and the existing targeted suite passed. No durable behavior or operating rule changed.

Expected: `not_material` with `routine_completion`.

### F08 — Duplicate assessment

Input: reconciliation sees `STA-2203` again under the same materiality policy version, and the assessment key already has a terminal material result mapped to `v1:reports:form-processing-reliability`.

Expected: `not_material` with `duplicate_candidate`; retain the known `documentKey` only to identify the duplicate.

### F09 — Already documented with no new fact

Input: `STA-2209` reruns an existing recovery procedure without changing any step, boundary, failure mode, or evidence. The canonical process document already contains the same verified behavior.

Expected: `not_material` with `already_documented_no_change`; retain the known canonical document identity and recommend no action.

### F10 — Non-durable investigation result

Input: `STA-2210` records a one-time staging restart and a transient queue depth observation with no reusable diagnosis, change, baseline, or follow-up rule.

Expected: `not_material` with `non_durable_result`.

## Review cases

All review cases must set `targetClass: "none"`, `documentKey: null`, `proposedAction: "none"`, `existingDocumentRef: null`, `safeDraft: null`, and `review.required: true`. They must ask one to three questions and contain no provisional draft or publish recommendation.

### F11 — Conflicting metric evidence

Input: `STA-2211` claims latency improved, but two safe benchmark summaries use different windows and show opposite results. Neither is designated authoritative.

Expected: `needs_review` with `conflicting_evidence`. Ask which benchmark and window are authoritative.

### F12 — Canonical identity ambiguity

Input: `STA-2212` changes retry behavior, but the existing-document index returns two plausible documents with overlapping subjects and no stable mapping.

Expected: `needs_review` with `canonical_identity_unclear`. Ask which document owns the durable retry policy.

### F13 — Multiple primary targets

Input: `STA-2213` contains both an independent architecture decision and a newly approved operator runbook, each with durable evidence, but the caller requests one result.

Expected: `needs_review` with `multiple_primary_targets`. Ask whether to assess the two durable subjects separately.

### F14 — Restricted source content

Input: `STA-2214` supplies only an unfiltered provider payload known to contain direct identifiers and authentication material. No sanitized issue, commit, test, metric, or document reference is available. Do not include any representative restricted value in the output.

Expected: `needs_review` with both `unsafe_source_content` and `insufficient_safe_evidence`. Ask for a sanitized evidence summary and safe source references.

## Fixture-wide safety assertion

No fixture output may contain a credential, token, cookie, raw provider payload, request or form body, stack local, customer record, name, email, phone number, address, account identifier, IP address, or signed URL. Synthetic issue identifiers, commit SHAs, aggregate metrics, test names, and opaque document IDs are allowed.
