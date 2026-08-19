# Outline completion documentation

This module projects materially useful completed Paperclip work into one maintained Outline document. Paperclip completion remains authoritative: the module has no source-issue mutation port, and publish receipts explicitly record `sourceIssueMutation: "none"`.

## Shadow contract

The completion materiality skill is the only classification source. Its exact structured result is validated before preview rendering:

- `not_material` and `needs_review` produce no Outline preview or provider call.
- `material` must name one Architecture, Reports, or Processes target, a matching template, and a stable canonical subject key.
- assessment identity is source issue plus materiality policy version;
- document identity is company plus canonical subject key, so later completions can update the same maintained document.

Preview bodies are sanitized again at the integration boundary. Obvious credentials, bearer values, email addresses, URL credentials, query strings, and fragments are removed. A preview records its target, deterministic Outline UUID, content hash, policy version, and `wouldPublish: false`.

Event and scheduled reconciliation share a durable assessment coordinator. It claims the stable company + source issue + policy key before invoking the materiality port, so overlapping observations coalesce and a completed assessment is never rerun under the same policy. The validated skill result and optional shadow preview are stored together for inspection; negative and review results persist with no preview. A lost lease or classifier failure leaves the assessment pending for a bounded later attempt and never mutates the source issue.

## Publishing gate

Default configurations remain structurally shadow-only. The guarded publisher is wired into runtime reconciliation and publishes a candidate's durable preview only when its module config carries an approved activation payload and every gate below passes — checked at config upsert and again on every reconciliation:

1. the module, destination, and external-write switches are enabled;
2. read-only mode is disabled;
3. a board/user confirmation accepted the exact destination configuration fingerprint;
4. the approved access mode is MCP and binds one exact Paperclip MCP connection plus exact document info/create/update tools;
5. a current proof confirms `read_write` access to the exact collection and parent;
6. the proof covers `documents.info`, `documents.create`, and `documents.update`;
7. the preview still resolves to the approved collection and parent.

Changing the MCP connection, connection revision, tool names, collection, or any parent invalidates both approval and writer proof before provider access. A gate that fails at runtime (kill switch, approval drift, expired proof, or no host-bound MCP runtime) records one visible exception, observes the candidate in shadow, and performs zero provider writes; the durable operation ledger, cursors, and receipts survive the rollback.

## Idempotency and reconciliation

The brokered Outline MCP tools permit a caller-supplied document UUID. The module derives it deterministically from company plus canonical subject key, reads that identity before mutation, and then creates or updates it. An unchanged rerun is a no-op.

A transport failure, provider 5xx, invalid success response, verification mismatch, or document conflict after a write is ambiguous. The module reads the deterministic UUID before deciding whether to retry:

- matching content is reconciled as success;
- a document under another destination is a terminal conflict;
- an absent or stale document returns a retryable redacted receipt.

The stable exception key is company plus source issue, allowing the shared exception store to upsert one visible exception instead of appending duplicates.

## Failure and rollback

- MCP authentication/scope denials and provider rejections are terminal.
- MCP rate-limit and provider-unavailable responses are retryable; a broker-provided retry delay is preserved when supplied.
- Receipts contain identity hashes and destination IDs, but never the title, body, token, or provider payload.
- A publishing failure never reopens, rewrites, or falsely completes the Paperclip issue.

The module contains no direct HTTP client, bearer token, or secret resolver; all provider access must arrive through the approved MCP port. Rollback is configuration-only: keep `readOnly=true`, `destinationEnabled=false`, and the external-write switch off. These defaults preserve reconciliation and preview inspection with zero external writes.

Provider-connected validation belongs to the separately evidenced QA sandbox UAT lane. Never substitute a production Outline identity.
