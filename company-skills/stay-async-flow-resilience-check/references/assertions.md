# Scenario assertions

Apply only the assertions relevant to the fixture scenario. Evidence must point to fixture fields or supplied authoritative source references; logs alone are never authority.

| Scenario | Required behavior |
|---|---|
| `duplicate_delivery` | Resolve both deliveries to one authoritative event identity, preserve one terminal result, and execute each logical side effect at most once. |
| `out_of_order_delivery` | Apply, defer, or ignore stale delivery according to the authoritative ordering rule; never regress terminal state or repeat effects. |
| `retry_after_timeout` | Treat timeout outcome as ambiguous. Reconcile by authoritative identity or retry with the same idempotency identity; never mint a new logical operation. |
| `partial_downstream_failure` | Preserve completed effects, retain failed or pending effects, and retry only incomplete work without duplicating completed effects. |
| `invalid_payload` | Reject before state mutation, enqueue, callback, or downstream side effect. |
| `idempotency` | Derive one stable operation key from the authoritative identity fields and reuse it across attempts and replays. |
| `terminal_state` | Once authoritative terminal state is reached, ignore or reject transitions out of it unless the contract explicitly defines a reopening transition. |
| `cleanup` | Remove only explicitly disposable non-terminal artifacts. Preserve the idempotency ledger, terminal evidence, and records needed for safe replay or recovery. |
| `replay` | Produce the same logical result from the same authoritative identity without duplicating effects or changing terminal outcome. |
| `recovery` | Resume from durable completed/pending state and converge without restarting already completed logical work. |

## Fail-closed negative cases

| Scenario | Required result |
|---|---|
| `missing_idempotency_identity` | `blocked` with `missing_event_identity_authority`. Do not derive identity from a delivery ID, timestamp, or payload guess. |
| `ambiguous_terminal_state` | `blocked` with `missing_terminal_state_authority`. Do not choose a terminal state from logs or naming conventions. |
| `unsafe_cleanup` | `blocked` with `unsafe_cleanup_requested`. Do not remove replay, recovery, identity, or terminal evidence. |
| `production_target_mismatch` | `blocked` with `production_target_mismatch`. Stop before any execution or access attempt. |

## Verdict precedence

1. Use `blocked` for a safety-boundary or authority failure.
2. Otherwise use `fail` for a deterministic mismatch against authoritative expected behavior.
3. Use `pass` only when every applicable check passes and every safety flag is false.
