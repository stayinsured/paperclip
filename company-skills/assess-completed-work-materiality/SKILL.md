---
name: assess-completed-work-materiality
description: Classify substantial completed engineering or operational work for durable Outline documentation. Return material, not_material, or needs_review with a safe Architecture, Reports, or Processes draft; never use this skill to publish or mutate Outline.
---

# Assess Completed Work Materiality

Decide whether completed work creates durable knowledge worth maintaining. Prefer no document over low-value reporting, and return a draft only when the materiality, destination, evidence, and canonical identity are clear.

This skill is classification-only. Do not call Outline, publish content, create folders, or treat the result as write authorization.

## Required inputs

Require these inputs before classifying:

- company-scoped source issue identifier and a sanitized completion summary
- claimed architectural, decision, outcome, metric, or operator-procedure changes
- safe source references such as issue IDs, commit SHAs, test artifact IDs, or existing document IDs
- known existing-document matches or a statement that the index was checked and no match was found
- materiality policy version

Treat missing existing-document lookup, missing durable evidence, or contradictory completion claims as uncertainty. Do not infer provider state or invent evidence.

## Load the references

- Read [references/output-contract.md](references/output-contract.md) before producing a result. Follow its fields, reason codes, and cross-field invariants exactly.
- Read [references/templates.md](references/templates.md) only after the result qualifies as `material`, then use the template mapped to the selected target class.
- Read [references/fixtures.md](references/fixtures.md) when calibrating, testing, or resolving an edge case. Treat those cases as acceptance fixtures.

## Classification workflow

### 1. Sanitize before judging

Discard secrets, credentials, cookies, authorization data, raw provider payloads, request or form bodies, stack locals, customer records, and direct identifiers. Generalize aggregate facts only when the aggregation is non-identifying and supported by a safe source reference.

Do not repeat restricted values, even as examples or quoted evidence. If the remaining sanitized evidence cannot support a decision, return `needs_review` with `unsafe_source_content` and/or `insufficient_safe_evidence`.

### 2. Refuse non-durable work first

Return `not_material` when the work is any of the following and the evidence is clear:

- routine delivery, dependency maintenance, formatting, copy, or administrative completion
- trivial correction with no durable design, operating, or measurable outcome
- one-off debugging detail, temporary workaround, or transient incident state
- duplicate assessment for the same source and policy version
- already represented in the canonical document with no new durable fact
- an outcome claim without a stable baseline, result, unit, window, or useful conclusion

Negative results must use `targetClass: "none"`, `proposedAction: "none"`, and `safeDraft: null`. Do not phrase them as publish recommendations.

### 3. Require all materiality gates

Return `material` only when all gates pass:

1. **Durable change:** the fact is expected to remain useful beyond the immediate task.
2. **Reusable audience:** another engineer, operator, reviewer, or decision-maker will predictably use it.
3. **Meaningful consequence:** it changes system understanding, future choices, measurable outcomes, or repeatable operations.
4. **Safe evidence:** at least one sanitized, inspectable source supports every central claim.
5. **Canonical placement:** one target class and one stable subject identity are clear.

Use these positive signals:

- a system boundary, component relationship, data flow, reliability model, or deployment topology was created or materially changed
- a consequential technical decision selected among alternatives and has durable trade-offs
- a substantial completed-task outcome or durable aggregate metric has a baseline, result, unit, measurement window, and limitations
- a repeatable operator procedure was created or materially changed and documents verification, failure handling, or rollback

Do not classify effort, code volume, task priority, or stakeholder visibility alone as material.

### 4. Route uncertainty to review

Return `needs_review` when evidence supports more than one reasonable result or a safe result cannot be completed without human judgment. Examples include conflicting results, an unclear canonical subject, equally strong target classes, a missing existing-document lookup, or restricted source data that cannot be safely separated.

Review results must not select a destination or draft content. Set `targetClass: "none"`, `proposedAction: "none"`, `safeDraft: null`, and ask one to three answerable questions.

### 5. Choose one target class

For `material`, choose exactly one:

- `Architecture`: system architecture, data-flow or reliability changes, and consequential decisions or ADRs
- `Reports`: significant completed-task outcomes and durable aggregate metrics
- `Processes`: repeatable operator procedures, runbooks, validation steps, and rollback practices

If two independent durable subjects require separate documents, return `needs_review` with `multiple_primary_targets`; do not combine them into a vague omnibus document.

### 6. Resolve canonical identity and update behavior

Build the canonical document key from the durable subject, not the issue title or completion date:

`v1:<target-class-lowercase>:<stable-non-sensitive-subject-slug>`

Use `update` when a document with that key already exists and the completion adds a durable fact. Use `create` only after the existing-document index has been checked and no match exists. Use `none` for duplicates, no-change results, and review cases.

Keep the assessment identity separate from the document identity so retries of one completion do not create duplicates. Use the source issue and policy version in the assessment key.

### 7. Draft only supported claims

Render the matching concise template. Include what changed, why it matters, evidence, consequences or outcomes, and the source issue. State uncertainty and measurement limitations explicitly. Omit empty or speculative sections.

Never copy raw logs or provider payloads into the draft. Never include secrets, customer names, emails, phone numbers, addresses, account identifiers, IP addresses, form contents, cookies, headers, query tokens, or unrestricted screenshots.

### 8. Validate and emit

Check every invariant in the output contract. Emit exactly one JSON object with the documented top-level fields, without surrounding prose or a Markdown fence.

Use only `material`, `not_material`, or `needs_review` for `classification`. Never claim that content was published.
