schema: stay-digital-hs-visual-gate-evidence/v2
outcome: EXECUTED_ONCE_RUN_FAILED_PACKAGE_DEFECT — exactly one dispatch at the accepted identity, attempt 1; run 32267409007 executed on a REAL runner and failed at its own preflight step (git exit 128: the frozen workflow's fetch-depth:1 shallow host checkout cannot resolve the parent binding HEAD^ = ff593d26); NOT the zero-runner outage fingerprint; authorization SPENT; never re-dispatched under this authorization; failure returns to CTO triage

# STA-2408 operator evidence — authorized re-trial dispatch of the hosted visual-gate (handoff rev 3)

## Outcome

**The single authorized re-trial dispatch was executed exactly once, at the accepted identity, run attempt 1 — and the created run FAILED at its own preflight step on a healthy runner.** Run `32267409007` (#192) was picked up by a real runner (`runner_id=1000002769`), executed 15 steps, produced a 313-line log and the controller's failing-evidence artifact, and terminalized `completed/failure` in 46 s. Root cause (from the job log, line-level): the preflight shell runs `git -C workflow-host rev-parse HEAD^` and dies `fatal: ambiguous argument 'HEAD^': unknown revision` (exit 128) because the frozen workflow pins `actions/checkout` with `fetch-depth: 1` for the workflow host — the parent binding `ff593d26` does not exist in a shallow clone. This is a **package-inherent, deterministic hosting defect** (workflow blob `6e19bab7` as frozen); the STA-2380 qualification executed the controller in a full local clone where `HEAD^` resolves, which is why it escaped qualification. The outage-fingerprint clause (§6) is NOT met: real runner, steps executed, logs and artifact captured. A failed attempt of any kind is never re-dispatched under this authorization; disposition returns to CTO triage.

## Authorization chain (verified this run, 2026-08-19 ~14:55Z)

- Handoff **revision 3** `ae656084-18d0-4ff4-ad31-6887c038a8d5` on STA-2281 `immutable-handoff` (supersedes rev 2 `a99c3f2b`); fetched fresh this run and executed against its §2/§4/§6/§8/§10 terms verbatim.
- Board confirmation **`e857f07a-264e-4b91-a13d-6bfe5ed4b0de` ACCEPTED 2026-08-19T14:51:32.678Z** (board user `JN5u…`), binding rev 3 — recorded in STA-2398 comment at 14:54:07.967Z with which STA-2398 flipped `done`.
- STA-2408 auto-unblocked (`issue_blockers_resolved`); operator = agent `9f22f9ed…` as named in §5; STA-2283 `done` (§4.1 sequencing).
- Operator performed exactly ONE mutation this run: the dispatch POST below. Everything else was read-only.

## All-off pre-state — verified fresh 2026-08-19T14:57:56Z–15:03Z, immediately before dispatch: ALL PASS

- **§4.1 sequencing:** STA-2283 `done`; its verdict `eb86ded6` (FAIL/environment, rev-2) stands superseded by this authorized re-trial, not reopened.
- **§4.2 dispatch baseline == 1:** full enumeration of workflow `272513204` runs shows exactly one `workflow_dispatch` run — the spent rev-2 trial `32257803101` (#189, attempt 1, completed/failure, head `8582652e6f`). Probe note: the `?event=workflow_dispatch` filter parameter returned a false `total_count=0` this afternoon; the unfiltered enumeration (100 most recent of 191 runs, covering far past 13:23Z) and a direct run fetch both confirm the single dispatch run. Raw responses retained (`dispatch-runs-pre.json`, `wf-runs-all.json`).
- **§4.3 no persistent gate:** `visual_gate_required` has no `default: true` in the frozen yml at `8582652e` nor at dev tip; repo variables readback at 14:58Z: 1 variable total, 0 matching gate/visual.
- **§4.4 manifest of record:** `artifacts/STA-2281/trial-authorization-manifest.json` sha256 `3a641e147d1362ad9c85f73eb0b4c1e8b1c5c2135ef302359a3d3ab6d626b4a6` (frozen `3a641e14…` byte-exact); authorization block `releaseGateActivation=disabled`, `productionDeployment=not-authorized`, `externalProviderWrites=not-authorized`.
- **§4.5 frozen objects:** all five blobs byte-exact at stated commits — workflow `6e19bab7`@`8582652e`, host contract `c7e6a8e8`@`ff593d26`, final contract `f76cddca`@`8582652e`, controller `244a3cf3`@`8582652e`, focused test `6957b075`@`8582652e`; frozen commit shape `parents=[ff593d26] tree=4803b656`.
- **§4.6 refs baseline:** `refs/heads/visual-gate/sta-2282-8582652e` → `8582652e6f4f73191389360e2a77529d46a73bc9` (commit); exactly one ref at the frozen SHA; zero tags at it (11 tags total). Diff vs the rev-2 post-dispatch baseline (79 heads): 7 added refs + dev/main moved — all ordinary engineering cadence outside the authorization scope (`sta-2392-*`, `sta-2399-*`, `ops/sta-2402-*`, `sta-2373-*`, `sta-2405-*`), none at the frozen SHA, none on `visual-gate/*`; this is the CTO-cleared scope-relative reading recorded in the STA-2398 release comment (14:54Z).
- **§4.7 Actions health probe:** run `32266720929` (`release-ui-react`, push) completed `success` 2026-08-19T14:55:11Z — job `96112897398` on `runner_id=1000002764`, 15 steps, 14 executed. Backup in-window: run `32263126088` (App Journeys) completed `failure` 14:32:52Z with executed steps (health = runners execute).
- **§4.8 excluded counters:** repo deployments readback 0 total; this operator's activity before the dispatch was 100% read-only.

## Dispatch — the single permitted mutation

```
POST /repos/stayinsured/web-platform/actions/workflows/272513204/dispatches
timestamp: 2026-08-19T15:00:12Z
body: {"ref": "visual-gate/sta-2282-8582652e", "inputs": {"candidate_sha": "7bdc3cbca394da29a7148b4ba6505826a360d07d", "visual_gate_required": "true"}}
--> HTTP 204
X-GitHub-Request-Id: 9EE6:5CE09:8BEB30:86AD15:6A85C4FA
```

## Run record — `32267409007` (#192), attempt 1

| field | value |
|---|---|
| workflow | HS Visual Regression, id 272513204, path `.github/workflows/hs-visual-regression.yml` |
| event / attempt | `workflow_dispatch` / **1** |
| head_sha / branch | `8582652e6f4f73191389360e2a77529d46a73bc9` / `visual-gate/sta-2282-8582652e` (run-time identity exact) |
| created / started / finished | 15:00:12Z / 15:00:16Z / 15:00:57Z (46 s) |
| status / conclusion | `completed` / `failure` |
| job | `96115190281` "Exact-SHA HubSpot Storybook visual gate", `runner_id=1000002769`, `runner_name=GitHub Actions 1000002769` |
| artifacts | `hs-visual-gate-failure-32267409007-1` (id 9370771556, 1909 B) — downloaded, extracted, SHA256SUMS verified |
| url | https://github.com/stayinsured/web-platform/actions/runs/32267409007 |

Step map: 1–3 success (setup, containers, host checkout) → **4 FAILURE** ("Validate gate intent and frozen bindings before candidate checkout") → 5–16 skipped (candidate checkout … enforce classification) → 17 success (credential scan, 0 findings) → 18–19 failure (finalize/enforce run evidence — fail-closed with missing inputs) → 20–22 skipped (passing-path uploads) → 23 success (**failing-evidence upload**) → post-steps success.

## Root cause (job log, step 4)

The preflight shell computes `host_parent="$(git -C workflow-host rev-parse HEAD^)"`. With the frozen workflow's host checkout pinned to `actions/checkout@11bd5960…` + `ref: ${{ github.workflow_sha }}` + **`fetch-depth: 1`** (frozen yml lines 31–37), the checkout is a single-commit shallow clone; the parent commit `ff593d26ec41565e1414175f012f79803438642b` is not present, so `git rev-parse HEAD^` exits 128 (`fatal: ambiguous argument 'HEAD^': unknown revision or path not in the working tree`) before the controller `244a3cf3` renders any contract verdict. The controller's fail-closed `finalize-run` then produced `hs-visual-gate-run-evidence.json` with `conclusion: "blocked"` and placeholder counters (`staleSha:1`, `retry_attempt`, `runtime_drift`, `unclassified:10`) — these are fill-ins from missing intermediate files, **not** substantive contract verdicts, and must not be read as gate rejections of the candidate. The candidate `7bdc3cbc…` was never checked out; no visual comparison ran.

**Failure class: package/hosting defect (frozen workflow self-incompatibility: shallow host checkout vs parent-binding preflight). Deterministic — every future dispatch of this exact frozen package on GitHub-hosted runners would fail identically at step 4.** Not the outage fingerprint; not operator/package-handling/authorization/identity error; not a candidate visual verdict.

## §8 rollback readback — 2026-08-19T15:03:36Z–15:07Z

- Dispatch count == 2 (both trials terminal, each attempt 1: `32257803101` rev-2, `32267409007` rev-3). No re-run, no re-dispatch.
- Gate off by construction: `visual_gate_required` input-only with no `default: true`, re-read post-run at BOTH the frozen commit and dev tip (PASS/PASS); no gate/visual repo variable existed at the 14:58Z readback. Probe note: the repo-variables endpoint 403'd on post-run retries (fine-grained PAT transient; succeeded pre-dispatch) — a dispatch POST cannot create repo variables, and the controller's activity counters record `exceptions: 0`.
- Authorized ref unmoved: `refs/heads/visual-gate/sta-2282-8582652e` still → `8582652e6f4f…`; refs scope-clean across the dispatch window (no additions/deletions; `refs/heads/main` advanced once — ordinary cadence, adjudicated in `rollback-readback.txt` with the raw strict-check line retained).
- Out-of-scope annotation for the verifier: run `32267720700` (`HubSpot Exact Sandbox Deploy`, `hubspot-exact-sandbox-deploy.yml`) was dispatched on `main` at 15:03:14Z by the shared GitHub account, concurrent with this trial — different workflow, different ref, outside this authorization; this operator's only mutation remains the single 15:00:12Z POST (request id above), and workflow `272513204`'s dispatch count is unaffected.
- Excluded activity of this operator: deployments 0, production changes 0, provider writes 0, credential changes 0, baseline updates 0, ref mutations 0 (read-only resolution verification only).

## Artifacts — `artifacts/STA-2408/` (control-plane workspace, committed + pushed)

`prestate-summary.txt` (all §4 checks), `prestate-sweep.sh`, `wf-identity.json`, `dispatch-runs-pre.json` (raw false-zero filter response), `wf-runs-all.json`, `frozen-commit.json`, `branch-ref.json`, `heads-current.json`, `heads-sweep.json`, `heads-sweep-post.json`, `tags-sweep.json`, `yml-8582652e….yml`, `yml-dev.yml`, `repo-variables.txt`, `health-probe-jobs.json`, `deployments.json`, `dispatch-response-headers.txt`, `dispatch-http-status.txt`, `dispatch-runs-post.json`, `run-record.json`, `run-jobs.json`, `run-watch-early.log`, `job-96115190281.log` (313 lines), `run-artifacts.json`, `failing-evidence/` (extracted artifact + `evidence/` bundle), `rollback-readback.txt`, `operator-evidence.md` (this document), `SHA256SUMS`.

## Terminal disposition

Authorization **SPENT** — one dispatch, one run, attempt 1, terminal `failure`. Never re-dispatched, never re-run under rev 3. Per handoff §5/§7 and the STA-2398 release: **failure returns to CTO triage** (no workaround, no retry by the operator); the independent verifier (QA `6beaba8b-d56c-49f2-b907-f2e512115d34`, distinct from operator and packager) verifies this record without repair or rerun on a CTO-opened follow-up issue. Evidence retention: **30 days** (failure path). The §8 ref-level cleanup (board-operator deletion of the branch) remains available post-verdict only.
