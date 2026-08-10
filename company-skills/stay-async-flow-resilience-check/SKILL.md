---
name: stay-async-flow-resilience-check
description: Offline, deterministic resilience assessment for sanitized async-flow changes involving webhook delivery, retries, queues, callbacks, form ingestion or HubSpot form handoffs, and instant-call orchestration across web-platform BFF, hubspot-forms-service, and instant-call-orchestrator. Use when QA must evaluate duplicate or out-of-order delivery, timeout retry, partial downstream failure, invalid payload handling, idempotency, terminal state, cleanup, replay, or recovery against authoritative code or contracts. Do not use for synchronous CRUD, frontend-only work, provider-behavior discovery, live integration tests, credentials, deployment, rollout, or any external or production access.
---

# Stay Async Flow Resilience Check

Evaluate sanitized asynchronous-flow evidence without contacting or mutating any system. Produce a deterministic, fail-closed result for independent QA review.

## Enforce the offline boundary

- Use only the supplied sanitized fixture and authoritative code, contract, or test references.
- Make zero network, provider, queue, webhook, callback, CRM, HubSpot, CloudTalk, Railway, deployment, repository-write, credential, customer-data, or production calls.
- Do not send fixture events, replay deliveries, invoke callbacks, inspect live state, or attach the skill to an agent.
- Treat logs and traces as observations only. Never treat them as authority or permission to infer provider behavior.
- Stop with `blocked` if the target is production, a credential or customer record is present, or validation would require external access.

## Require authoritative inputs

Require a fixture that conforms to [references/fixture.schema.json](references/fixture.schema.json) and supplies:

- a synthetic target and explicit environment identity
- the event-identity rule and its authoritative source reference
- the terminal-state rule and its authoritative source reference
- ordered synthetic deliveries and simulated outcomes
- expected final state, side-effect counts, cleanup decision, and replay outcome

Accept event identity and terminal-state authority only from versioned code or an approved contract. Deterministic tests may support retry assertions but must not replace those sources. If event identity, terminal states, or their evidence is missing or contradictory, do not guess; return `blocked` with the matching reason code.

## Load the package contract

1. Read [references/fixture.schema.json](references/fixture.schema.json) for normalized inputs.
2. Read [references/result.schema.json](references/result.schema.json) for the only valid output shape.
3. Read [references/assertions.md](references/assertions.md) for scenario-specific assertions and fail-closed rules.
4. Read [references/fixtures.json](references/fixtures.json) when calibrating or running the packaged acceptance set.

## Evaluate deterministically

For each fixture:

1. Confirm the fixture schema, synthetic marker, environment, source-of-truth references, and expected scenario.
2. Resolve event identity exactly as the authoritative rule states. Do not substitute delivery ID, timestamp, order, or provider assumptions.
3. Apply deliveries in `arrivalIndex` order while preserving the fixture's stated event sequence.
4. Record every delivery decision, state transition, completed effect, pending effect, retry, rejection, cleanup decision, replay decision, and recovery decision.
5. Compare the observed result with every expected field. A single unexplained or unevidenced difference is `fail`.
6. Use `blocked` instead of `fail` when authority or the safe test boundary is missing, ambiguous, contradictory, or production-targeted.
7. Validate the result against [references/result.schema.json](references/result.schema.json).

Do not award partial credit. A scenario passes only when all applicable assertions pass and all safety flags remain false.

## Emit one result

Return exactly one JSON object with no surrounding prose or Markdown fence. Set every safety boolean explicitly. Include authoritative event-identity and terminal-state references, even for a passing fixture. Use only reason codes and check names declared in the result schema.

Never claim a live provider, deployment, queue, webhook, callback, or customer flow was tested. The result proves only deterministic offline behavior against the supplied authoritative contract.
