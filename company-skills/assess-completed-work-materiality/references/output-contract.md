# Output contract

Return exactly one JSON object with these top-level fields and no others:

```json
{
  "classification": "material",
  "reasonCodes": ["architecture_changed"],
  "targetClass": "Architecture",
  "canonicalIdentity": {
    "assessmentKey": "v1:paperclip:STA-1841:policy-1",
    "documentKey": "v1:architecture:completion-documentation-flow",
    "proposedAction": "update",
    "existingDocumentRef": "outline-doc-opaque-id"
  },
  "evidence": [
    {
      "kind": "issue",
      "sourceRef": "STA-1841",
      "claim": "The completed change introduced a durable completion-classification boundary."
    }
  ],
  "safeDraft": {
    "template": "architecture_decision",
    "title": "Completion documentation flow",
    "bodyMarkdown": "## Context\n..."
  },
  "review": {
    "required": false,
    "questions": []
  }
}
```

## Fields

| Field | Required contract |
|---|---|
| `classification` | Exactly `material`, `not_material`, or `needs_review`. |
| `reasonCodes` | Non-empty array of unique allowed codes. Use only codes valid for the classification. |
| `targetClass` | Exactly `Architecture`, `Reports`, `Processes`, or `none`. |
| `canonicalIdentity.assessmentKey` | Non-sensitive stable key: `v1:<source-system>:<source-id>:<policy-version>`. |
| `canonicalIdentity.documentKey` | Stable subject key or `null`: `v1:<target-class-lowercase>:<subject-slug>`. Never use a customer name. |
| `canonicalIdentity.proposedAction` | Exactly `create`, `update`, or `none`. This is a draft-routing proposal, not authorization. |
| `canonicalIdentity.existingDocumentRef` | Safe opaque document ID or canonical URL without credentials/query strings; otherwise `null`. |
| `evidence` | Array of sanitized evidence objects. Each object has only `kind`, `sourceRef`, and `claim`. |
| `safeDraft` | Draft object for `material`; otherwise `null`. |
| `review` | Object with `required` boolean and zero to three concise `questions`. |

Allowed `evidence.kind` values are `issue`, `commit`, `test`, `metric`, and `document`.

The `safeDraft` object has exactly `template`, `title`, and `bodyMarkdown`. Allowed template values are `architecture_decision`, `completed_task_outcome`, and `operator_process`.

## Reason codes

Use only these codes.

### `material`

- `architecture_created`
- `architecture_changed`
- `durable_decision`
- `significant_delivery_outcome`
- `durable_outcome_metrics`
- `operator_procedure_created`
- `operator_procedure_changed`

### `not_material`

- `routine_completion`
- `trivial_change`
- `non_durable_result`
- `insufficient_outcome`
- `duplicate_candidate`
- `already_documented_no_change`
- `evidence_not_durable`

### `needs_review`

- `ambiguous_materiality`
- `conflicting_evidence`
- `canonical_identity_unclear`
- `destination_unclear`
- `multiple_primary_targets`
- `unsafe_source_content`
- `insufficient_safe_evidence`

## Cross-field invariants

### Material

- Set `targetClass` to one of `Architecture`, `Reports`, or `Processes`.
- Set `proposedAction` to `create` or `update`.
- Set `documentKey` to a non-sensitive canonical key.
- Include at least one evidence item supporting each central claim.
- Set `safeDraft` to the template matching the target class.
- Set `review` to `{ "required": false, "questions": [] }`.

Template mapping:

| Target class | Template |
|---|---|
| `Architecture` | `architecture_decision` |
| `Reports` | `completed_task_outcome` |
| `Processes` | `operator_process` |

### Not material

- Set `targetClass` to `none`, `proposedAction` to `none`, and `safeDraft` to `null`.
- Set `review` to `{ "required": false, "questions": [] }`.
- Set `documentKey` and `existingDocumentRef` only when identifying the known duplicate or already-current document; otherwise set both to `null`.
- Do not use words such as "publish", "create document", or "update document" as a recommendation in any claim.

### Needs review

- Set `targetClass` to `none`, `documentKey` to `null`, `proposedAction` to `none`, `existingDocumentRef` to `null`, and `safeDraft` to `null`.
- Set `review.required` to `true` and include one to three questions whose answers would resolve the ambiguity.
- Do not select a likely destination or supply provisional publish content.

## Canonical identity rules

- Normalize the durable subject, not the task title, date, team, or implementer, into a lowercase kebab-case slug.
- Keep the key stable across reruns and later work on the same subject.
- Prefer `update` when an existing canonical key or confirmed semantic match exists.
- Return `duplicate_candidate` when the same assessment key was already handled.
- Return `already_documented_no_change` when a canonical document exists but the new completion adds no durable fact.
- Return `canonical_identity_unclear` when two existing documents appear to represent the same subject or the durable subject cannot be named safely.

## Evidence and safety rules

Allow only:

- Paperclip issue identifiers and sanitized summaries
- commit SHAs and safe repository-relative paths
- test names, artifact IDs, or non-sensitive result summaries
- aggregate metrics with baseline, result, unit, window, sample limits, and caveat
- opaque existing-document IDs or canonical URLs stripped of query strings

Omit:

- secrets, tokens, credentials, cookies, authorization headers, environment values, and signed URLs
- raw Sentry, HubSpot, Slack, ClickUp, Outline, or other provider payloads
- request bodies, form submissions, stack locals, unrestricted logs, and screenshots containing user data
- customer records and direct or indirect PII, including names, emails, phone numbers, addresses, account IDs, and IP addresses

Never preserve a restricted value merely by moving it into `evidence`, `title`, `bodyMarkdown`, `sourceRef`, or a canonical key. If safe evidence is insufficient after omission, use `needs_review`.
