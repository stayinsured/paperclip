# Worked example: recurrent backend issue

## Safe input summary

- Issue: `FORMS-42` at `https://sentry.example.invalid/issues/FORMS-42`
- Project/environment: `forms-service` / `production`
- Category/platform: error / node
- Lifecycle: regressed; first seen 14 days ago; last seen 8 minutes ago
- Aggregates: 184 events and 31 affected users in the selected production window
- Release correlation: recurrence began after release `forms-2026.08.7`
- Normalized in-app location: `src/submissions/normalize.ts`, function `normalizeSubmission`

## Application

The issue is recurrent production behavior with limited aggregate reach, so severity is `medium`. Release timing and the normalized in-app location support a hypothesis, but neither proves which input state caused the failure. Confidence stays `medium`. The narrowest next check compares the deployed release's normalization guard with the prior release; it does not reproduce or copy event input.

## Output

```yaml
proposal_revision: "sentry:FORMS-42:r1"
source:
  sentry_issue_url: "https://sentry.example.invalid/issues/FORMS-42"
  issue_key: "FORMS-42"
  project: "forms-service"
  environment: "production"
data_handling:
  allowlist_applied: true
  excluded_sensitive_data: "unknown"
  raw_detail_copied: false
severity:
  level: "medium"
  confidence: "medium"
  rationale: "A production regression recurred 184 times and reached an aggregate 31 users; broader workflow impact is unconfirmed."
  urgency: "Human review during the current engineering cycle is recommended."
affected_component:
  observed_in: "forms-service submission normalization"
  probable_owner: "forms-service"
  ownership_confidence: "medium"
evidence:
  - id: "E1"
    source_field: "aggregate recurrence"
    observation: "The issue is a production regression with 184 events in the selected window."
  - id: "E2"
    source_field: "release correlation"
    observation: "Recurrence begins after release forms-2026.08.7."
  - id: "E3"
    source_field: "normalized code location"
    observation: "The top in-app location is the submission normalization function."
probable_root_cause:
  hypothesis: "A normalization guard changed in the correlated release and no longer accepts one supported submission shape."
  confidence: "medium"
  evidence_ids: ["E1", "E2", "E3"]
  alternatives:
    - "An upstream producer began sending a previously unseen but valid shape at the same time."
  missing_evidence:
    - "A read-only diff of the deployed normalization guard against the prior release."
customer_impact:
  confirmed:
    - "The selected production window includes an aggregate 31 affected users."
  unknown:
    - "Whether a submission was lost, retried successfully, or blocked."
  confidence: "low"
diagnostic_next_step:
  read_only_check: "Compare the deployed normalization guard in forms-2026.08.7 with its prior release."
  expected_evidence: "A changed branch that explains the normalized failure class would support the hypothesis; no relevant change would weaken it."
  confidence_effect: "A matching change raises root-cause confidence; its absence shifts investigation to the upstream producer."
fix_options:
  - option: "Restore acceptance of the supported shape at the normalization boundary."
    scope: "forms-service submission normalization"
    expected_benefit: "Prevents the recurrent rejection while preserving boundary validation."
    tradeoffs:
      - "A broader accepted shape could hide malformed producer data unless validation remains explicit."
    validation:
      - "Synthetic regression coverage for supported and malformed shapes."
  - option: "Correct the upstream producer if the emitted shape violates the approved contract."
    scope: "upstream producer contract"
    expected_benefit: "Keeps the forms-service boundary strict."
    tradeoffs:
      - "Cross-system rollout timing can extend the recurrence window."
    validation:
      - "Contract evidence and a synthetic producer-to-consumer test."
no_fix_boundary:
  crossed: false
  rationale: "A recurrent production regression with a plausible bounded change surface justifies proposing remediation."
  revisit_when:
    - "If diagnostics show only unsupported inputs, reconsider implementation and document the producer contract instead."
approval_gate:
  required: true
  target_revision: "sentry:FORMS-42:r1"
  status: "not_requested"
  execution_allowed: false
  note: "This skill cannot request/record approval, create work, or remediate."
```
