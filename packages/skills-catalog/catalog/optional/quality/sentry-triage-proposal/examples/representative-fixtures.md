# Representative classification fixtures

These synthetic fixtures exercise the classification boundary without reproducing event payloads. Every expected result retains the Sentry link, uses aggregate or normalized evidence only, and keeps execution disabled.

## Fixture 1 — recurring production failure

Condition: an ongoing backend issue has 240 events across three production releases, a stable normalized in-app location, and limited aggregate user reach.

```yaml
expected:
  severity: medium
  root_cause_confidence: medium
  affected_component: backend validation boundary
  impact_confidence: low
  diagnostic: compare the boundary behavior across the three releases
  fix_options: 2
  no_fix_boundary_crossed: false
  raw_detail_copied: false
  execution_allowed: false
```

## Fixture 2 — noisy client event

Condition: a low-volume browser issue occurs only in an unsupported extension context, has no in-app location, and has not escalated.

```yaml
expected:
  severity: low
  root_cause_confidence: unknown
  affected_component: client edge
  impact_confidence: unknown
  diagnostic: verify the aggregate environment and in-app-frame distribution
  fix_options: 0
  no_fix_boundary_crossed: true
  raw_detail_copied: false
  execution_allowed: false
```

## Fixture 3 — low context

Condition: the issue environment is unknown, only one occurrence is visible, and no release, normalized code location, or cross-system relationship is available.

```yaml
expected:
  severity: unknown
  root_cause_confidence: unknown
  affected_component: unknown
  impact_confidence: unknown
  diagnostic: confirm the environment and obtain aggregate recurrence metadata
  fix_options: 0
  no_fix_boundary_crossed: true
  raw_detail_copied: false
  execution_allowed: false
```

## Fixture 4 — cross-system timeout

Condition: a BFF reports repeated production timeouts while a safe trace relationship shows an upstream call ending unavailable; no deployed-code correlation exists.

```yaml
expected:
  severity: high
  root_cause_confidence: medium
  affected_component: upstream integration boundary
  impact_confidence: low
  diagnostic: compare upstream availability aggregates with the BFF timeout window
  fix_options: 2
  no_fix_boundary_crossed: false
  raw_detail_copied: false
  execution_allowed: false
```

## Fixture 5 — sensitive data present in the source

Condition: the raw event contains customer-identifying and credential-like values. The connector reports only that sensitive values were present and excluded; no values are reproduced.

```yaml
expected:
  severity: medium
  root_cause_confidence: unknown
  affected_component: configured source component
  impact_confidence: unknown
  diagnostic: use safe aggregate metadata or repository evidence without reopening excluded values
  fix_options: 0
  no_fix_boundary_crossed: true
  excluded_sensitive_data: present
  raw_detail_copied: false
  execution_allowed: false
```

## Fixture 6 — confirmed high-severity regression

Condition: a regressed production issue blocks a critical workflow across two regions, event volume is escalating, and the matching deployed release plus normalized code location are verified.

```yaml
expected:
  severity: critical
  root_cause_confidence: high
  affected_component: critical workflow service
  impact_confidence: medium
  diagnostic: read-only verification of the suspected branch against the deployed release
  fix_options: 2
  no_fix_boundary_crossed: false
  urgent_human_review: true
  raw_detail_copied: false
  execution_allowed: false
```

Consistency rule: rerunning a fixture with the same allowlisted facts must preserve severity and confidence. A changed classification must cite the changed allowlisted evidence and receive a new `proposal_revision`.
