# Concise safe-draft templates

Use exactly one template for a `material` result. Keep titles under 90 characters, write in plain language, omit empty sections, and prefer links or safe references over copied raw evidence.

## Architecture or decision

Target class: `Architecture`
Template: `architecture_decision`

```markdown
# <Stable system or decision subject>

## Context
<Why a durable change or decision was needed.>

## Decision or architecture change
<What boundary, data flow, component relationship, reliability model, or choice now applies.>

## Rationale and alternatives
<Why this option was selected and the meaningful alternatives rejected.>

## Consequences
<Operational effects, trade-offs, constraints, and follow-up triggers.>

## Evidence
- <Safe issue, commit, test, or document reference supporting the claims.>

## Source
<Paperclip issue identifier and completion date.>
```

Keep this to roughly 200–500 words. Do not manufacture alternatives when none were recorded; classify an unsupported decision claim as `needs_review` instead.

## Completed-task outcome

Target class: `Reports`
Template: `completed_task_outcome`

```markdown
# <Stable outcome subject>

## Outcome
<What materially changed for the product, system, or operating objective.>

## Why
<The problem or goal addressed.>

## What changed
<Only the implementation facts needed to understand the outcome.>

## Results
<Baseline → result, unit, measurement window, sample limits, and causal caveat, or another durable outcome with inspectable evidence.>

## Evidence
- <Safe issue, commit, test, metric, or artifact reference.>

## Source
<Paperclip issue identifier and completion date.>
```

Keep this to roughly 150–400 words. Do not turn task chronology, code volume, or "tests passed" alone into an outcome report.

## Operator process

Target class: `Processes`
Template: `operator_process`

```markdown
# <Stable process name>

## Purpose and trigger
<When an operator should use this process and the safe outcome it protects.>

## Preconditions
- <Required role, environment identity, or non-secret configuration.>

## Steps
1. <Action stated without credentials or customer data.>
2. <Action.>

## Verification
<Observable success and stop conditions.>

## Failure and rollback
<Safe recovery, escalation owner, and rollback boundary.>

## Ownership and review trigger
<Owning role and event that should prompt a review of this process.>

## Evidence and source
- <Safe issue, test, or runbook reference.>
```

Keep this to roughly 200–600 words. Never embed tokens, customer examples, production payloads, or commands containing secret values.
