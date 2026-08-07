# Browser Release Gate

## Activation state

The reusable gate is implemented in
.github/workflows/browser-release-gate.yml. Dev pushes call it with immutable
github.sha through .github/workflows/dev-browser-gate.yml. The release verifier
exposes enable_browser_gate, but its default is false and the production release
workflow does not enable it. Production activation requires the later
exact-configuration board confirmation.

The gate accepts only a full 40-character commit SHA. Each suite checks out that
value, compares git rev-parse HEAD to it, runs in the checkout, and writes both
expected and observed SHA into the evidence artifact. It never downloads a
previous run's green result.

## Failure policy

tests/browser-gate/failure-policy.json classifies current e2e and visual tests as
critical. A missing JSON report, setup failure without test evidence, or a
failure that has no matching policy rule is unclassified. A test that passes
only after retry is flaky. Critical, unclassified, and flaky results always fail
the gate and cannot be waived.

Changing a test to non_critical is a release-policy change. It requires review
by DevOps and QA and must not be used to re-label an unresolved critical journey.

## Baseline governance

The visual gate fails closed until
tests/storybook-visual/baseline-manifest.json points to a real immutable archive
and contains sourceCommit plus qaEvidence with:

- status: PASS
- commit: the same 40-character sourceCommit
- issue: a company-prefixed Paperclip issue path
- workflowRun: the exact GitHub Actions run URL
- reviewedAt: a valid non-future UTC timestamp

The gate verifies that sourceCommit is the exact last commit that changed the
manifest and is an ancestor of the candidate. The QA evidence must be PASS,
SHA-matched, and linked to an exact Actions run. Screenshot generation never
updates or accepts the manifest automatically.

## Evidence and retention

Both suites use only the repository's synthetic local fixtures. The gate does
not inject LLM, customer, provider, or production credentials. Evidence contains
the candidate/observed SHA, workflow runner image, Playwright/browser versions,
baseline identity, failure titles, classifications, reports, screenshots, and
traces.

- Passing artifacts: 7 days.
- Failing, blocked, or incomplete artifacts: 30 days.
- Waiver audit artifacts: 30 days.

Do not add real customer data, cookies, tokens, provider payloads, or production
screenshots to browser fixtures. A discovered leak is a critical gate failure;
delete the affected Actions artifact and rotate any exposed credential.

## Emergency waiver

Waivers are for an already-reviewed non_critical classification only. They
cannot override critical, unclassified, or flaky results.

Repository operators must configure the
browser-release-gate-emergency-waiver GitHub environment with board required
reviewers and self-review prevention, and set BROWSER_GATE_BOARD_ACTORS to the
comma-separated GitHub logins allowed to request the waiver. A waiver request
must name the exact candidate SHA, a Paperclip issue, a reason of at least 20
characters, and an expiry no more than 24 hours away. Environment review and the
30-day JSON artifact form the audit record.

## Production activation

After the exact configuration, QA evidence, rollback target, and board
confirmation are accepted:

1. Resolve the requested release ref to a full SHA in a dedicated job.
2. Pass that SHA as ref to release-verify.yml.
3. Set enable_browser_gate: true in the approved release caller revision.
4. Make the publish job depend on that exact invocation.

Do not pass a branch or tag when the gate is enabled; full-SHA validation will
reject it.

## Rollback

Record the last known-good gate commit before activation. If gate code regresses,
revert only the gate activation or gate implementation commit on dev, rerun the
reusable workflow for the same candidate SHA, and require both suites to settle.
Do not update baseline-manifest.json during rollback and do not accept new
screenshots. If release activation had been enabled, revert the caller first so
publishing returns to the last board-approved gate configuration.

Targeted verification commands:

    node --test scripts/__tests__/browser-release-gate.test.mjs
    node --test scripts/__tests__/release-verify-workflow.test.mjs
