# STA-2281 Hosted Visual-Gate Trial — Immutable Authorization Handoff, Revision 3 (re-trial under fresh authorization)

**Revision 3 supersedes revision 2 (`a99c3f2b-6590-47f7-b4fc-439fe0bbd369`).** Revision 2 — like revision 1 (`832b018f-378f-474e-a6eb-e0e48008a156`) — remains immutable record. Revision 2's confirmation `ccc02c59…` (accepted 2026-08-19T13:18:31Z) is **SPENT**: exactly one dispatch was executed under it (run `32257803101`, 2026-08-19T13:23:21Z, HTTP 204), and a spent or failed attempt is never re-dispatched under its acceptance. The `request_confirmation` attached to **this** revision is the only confirmation that authorizes anything on this page; its acceptance — and only its acceptance — authorizes the bounded sequence in §10.

**What changed and why (the only deltas from revision 2):** the rev-2 dispatch executed exactly as authorized but never acquired a runner — run `32257803101` concluded `completed/failure` at job setup (`runner_id=0`, zero steps, 2-second job) inside a **repo-wide GitHub Actions execution outage** that ran 2026-08-19T10:20:41Z→13:32:18Z and felled every run of every workflow in the repository. Independent verdict **STA-2283 FAIL, environment class** (report comment `eb86ded6…`): rows 1–5 and 8–11 all PASS — identity, single dispatch, SHA corroboration, byte-exact frozen artifacts, outage classification, rollback readback, zero excluded activity, bundle checksums — only rows 6–7 fail, for lack of hosted execution evidence. The outage is over (**STA-2403 done**: recovery sustained from 13:48:47Z, first success run `32260268537` at 13:49:23Z). **The frozen package remains qualified — STA-2380 PASS stands; no rework.** What is missing is hosted execution evidence, which this revision re-authorization obtains. Concretely, the deltas are: (a) the dispatch baseline is now **1** spent run, and this revision authorizes exactly **one additional** dispatch (§2, §4.1, §6); (b) **no ref creation** — the §2a ref created by the board operator under revision 2 still exists at the frozen SHA and is re-verified fresh (§2a); (c) the operator executes **STA-2404** (re-trial issue, child of STA-2276) and independent verification moves to a **new** QA issue — the closed STA-2283 report is never edited (§5, §7); (d) the QA-flagged evidence-bundle truncation is repaired and the rev-3 bundle is produced untruncated (§7). Every frozen value — repository, workflow, host commit, candidate, blobs, inputs, stop conditions, evidence, rollback — is unchanged from revision 2 and restated verbatim below.

A superseding board/user comment invalidates a pending confirmation; a fresh confirmation would then be required against a fresh revision.

## 1. Basis

- Qualification of record is PASS: **STA-2380** (verdict comment `aedd9fb3…`, 2026-08-19T10:29:31Z) — six evidence objects byte-exact over the QA run's own sandbox bridge route; steps 4–6 executed (9/9 git-object inventory, 9/9 focused test, 10/10 QA extension, five fail-closed counterexamples). Deployment-reach fix **STA-2379 PASS** (build `ed94f3e5…`, fresh-run byte-exact fetch). Full detail: revision 1 §1 (unchanged).
- **Rev-2 execution record:** single authorized dispatch at named ref `visual-gate/sta-2282-8582652e` → HTTP 204 (X-GitHub-Request-Id `DB88:368B80:…`), run `32257803101` (#189), attempt 1, `head_sha` = frozen `8582652e6f4f…`, workflow identity exact — then `completed/failure` at job setup: zero steps, zero logs, zero artifacts, `runner_id=0`. Root cause: repo-wide Actions execution outage 10:20:41Z→13:32:18Z (27+ runs felled; last repo-wide success 08:39:20Z). §8 rollback readback clean at 13:26:33Z: dispatch count exactly 1, refs net-unchanged, branch still at frozen SHA, zero excluded mutations. Evidence: `operator-evidence` rev 2 `b7828e63…` + `artifacts/STA-2282/rev2/` on STA-2282.
- **Verdict and triage of record:** STA-2283 FAIL (environment class) as above; STA-2283 is closed with that single durable report. CTO triage comment `86fb6127…`: accept the FAIL, no rework, re-trial under fresh authorization once the outage clears. Outage tracker **STA-2403 done**: recovery sustained (6 runs / 9 runners / 10–18 steps across push+PR+dispatch; first success 13:49:23Z); post-recovery failures execute steps and are genuine outcomes, not outage.
- **Re-trial pre-state verification (fresh, read-only, 2026-08-19T13:57–13:59Z):** named ref `visual-gate/sta-2282-8582652e` → `8582652e6f4f73191389360e2a77529d46a73bc9` exact; candidate `7bdc3cbca394da29a7148b4ba6505826a360d07d` resolves with recorded tree `d5a18426713faca1d26f2f8498d97f05f2daaa33`; workflow `272513204` dispatch-event run count = exactly 1 (the spent rev-2 run); all five frozen blobs re-verified byte-exact at their stated commits (4 at `8582652e`, host contract `c7e6a8e8` at `ff593d26`); multiple step-executing runs succeeded since 13:48Z.

## 2. Exact dispatch target — one additional dispatch, attempt 1 (unchanged from revision 2 except the count row)

| field | value |
|---|---|
| Repository | `stayinsured/web-platform` (GitHub repository id `1076455328`) |
| Workflow | `HS Visual Regression`, id `272513204`, path `.github/workflows/hs-visual-regression.yml` |
| Dispatch ref (API spelling) | **named ref `visual-gate/sta-2282-8582652e`** (branch, `refs/heads/visual-gate/sta-2282-8582652e`) |
| Ref must resolve to | **`8582652e6f4f73191389360e2a77529d46a73bc9`** (frozen final binding, bundle ref `frozen-visual-gate`); run-time identity check `github.workflow_sha == 8582652e6f4f73191389360e2a77529d46a73bc9` is unchanged and still enforced |
| Input `candidate_sha` | **`7bdc3cbca394da29a7148b4ba6505826a360d07d`** (tree `d5a18426713faca1d26f2f8498d97f05f2daaa33`) |
| Input `visual_gate_required` | `true` (the only "enabled" element; per-run input, nothing persistent) |
| Count / attempt | **exactly 1 additional dispatch (the second dispatch of this workflow overall, after the spent rev-2 run), run attempt 1** (`expectedRunAttempt: 1`, `retries: 0`, `workers: 1`) |
| Environment | Non-production: GitHub-hosted `ubuntu-24.04` runner in `mcr.microsoft.com/playwright:v1.59.1-noble@sha256:b0ab6f3c…`, workflow permissions `contents: read` only |

Identity preservation: the named ref is a pointer, not content. The workflow file executed is the file at the commit the ref resolves to — the same commit revision 1 bound (`8582652e…`, workflow blob `6e19bab7…`); the §6 revision-drift check on `github.workflow_sha` makes any other resolution a hard stop. Dispatching the named ref executes exactly the commit the board already authorized; rev 3 changes only the count baseline, not the target.

Why the ref target is exact (unchanged): the frozen controller (`244a3cf3`) accepts only the **contract-only-child** binding — dispatch host `8582652e`, parent `ff593d26`, sole changed path the contract file. Dispatching at `ff593d26` fails preflight (host contract `c7e6a8e8` there still binds prior host `543dd6dc`); any other ref fails `workflow_runtime_drift`. The candidate input must equal the contract candidate `7bdc3cbc` (`stale_sha` otherwise) and must differ from the host (`host_candidate_not_distinct`).

## 2a. Authorized ref — already created under revision 2; no ref mutation under this revision

- **Ref:** `refs/heads/visual-gate/sta-2282-8582652e`, created by the board operator under revision 2 §2a before its confirmation was accepted. **It exists and resolves to `8582652e6f4f73191389360e2a77529d46a73bc9`** (rev-2 §8 rollback readback 13:26:33Z; re-verified fresh 2026-08-19T13:57Z, operator, read-only).
- **No creation, move, or delete of any ref — in any repository, by anyone — is authorized under this revision.** The ref must still resolve to the frozen SHA at dispatch time; the operator independently re-verifies `named ref → 8582652e6f4f…` read-only immediately before the dispatch. Agent principals — operator `9f22f9ed…` and CTO/packager `805da696…` — remain not authorized to mutate refs (no agent token in this environment carries ref-write permission). If the ref is found moved or missing at verification time, that is a stop condition → return to CTO; the operator does not recreate it.

## 3. Replacement objects (frozen, unchanged from revisions 1–2; re-verified byte-exact 2026-08-19T13:58Z)

- Final binding commit `8582652e6f4f73191389360e2a77529d46a73bc9` (tree `4803b656275364c7b56a9682655a089230f5882c`, parent `ff593d26ec41565e1414175f012f79803438642b`, only-child path `.github/config/hs-visual-regression-contract.v2.json`, strategy `single-contract-only-child/v1`).
- Workflow `.github/workflows/hs-visual-regression.yml` blob `6e19bab7b2e030560ad9490335a6ef0883a1af53`.
- Host contract (at `ff593d26`) blob `c7e6a8e8e5b554d530e52152311e4692767302fe`; final contract (at `8582652e`) blob `f76cddcab55b553e3dfe6b920d2c271721cc5788`.
- Controller `scripts/hs-visual-regression-evidence.mjs` blob `244a3cf31df940b0e6269acb6262a37735ecd325`.
- Focused test `.github/workflows/hs-visual-regression.test.mjs` blob `6957b075155bd2b423d46dbfe46267245c0ca30c`.
- Deeper history object named for rollback: `abd70249629419c6b14d41d59b754f9e455028a1`.
- Repository identity: `stayinsured/web-platform`, branch `dev`, fetched-dev `7fa0eb54bc6aed51485cad2cacb52ea92d86d2cc` with the final binding as ancestor; expected manifest payload sha `d642f611…` (workflow preflight enforces).
- Machine-readable manifest: revision 1 attachment `5424b10e-1a8c-4108-8fc5-755192cd4971` (`trial-authorization-manifest.json`, SHA-256 `3a641e14…`) remains the frozen-object manifest of record; revisions 2 and 3 change no frozen object it carries.

## 4. All-off pre-state (operator verifies before dispatch)

1. Dispatch-event run count of workflow `272513204` = **exactly 1** (the spent rev-2 dispatch, run `32257803101`, attempt 1, concluded failure); re-verified immediately before the dispatch. After the authorized dispatch: exactly 2. Re-run, deletion, or disappearance of the spent run is a stop condition (§6).
2. No persistent visual-gate requirement in the hosted repository — gate intent exists only as the per-dispatch input.
3. Accepted-manifest authorization block unchanged: `releaseGateActivation: disabled`, `productionDeployment: not-authorized`, `externalProviderWrites: not-authorized`.
4. Frozen objects unmodified on the remote (all five blobs above resolve at their stated commits).
5. Exactly one git ref exists beyond the pre-decision baseline: `refs/heads/visual-gate/sta-2282-8582652e`, resolving to `8582652e6f4f73191389360e2a77529d46a73bc9` (created under rev 2 §2a). Any other new/modified ref, or this ref resolving anywhere else, is a stop condition.
6. Excluded counters stay zero: deployments, production changes, provider writes, credential changes, baseline updates — and, for agent principals, git ref mutations of any kind.

## 5. Operator and independent verifier

- **Operator:** agent `9f22f9ed-33dc-466b-aeb0-7fb36bb360f4` (runtime owner, STA-2368/STA-2379 fix owner, rev-2 executor) executing **STA-2404** (re-trial, child of STA-2276). Non-production trial; the separately-authorized-production-operator rule is not implicated.
- **Independent verifier:** QA agent `6beaba8b-d56c-49f2-b907-f2e512115d34` on a **new, independent QA verification issue opened for the new run** — never an edit of the closed STA-2283 report, whose single durable FAIL verdict stands as the rev-2 record. Operator and verifier are distinct from the packager (CTO `805da696…`).

## 6. Stop conditions (fail-closed, before mutation or dispatch)

- **Identity drift** — repository id, workflow id/name/path mismatch.
- **Revision drift** — `github.workflow_sha` ≠ `8582652e6f4f…`, or observed blobs ≠ `6e19bab7` / `244a3cf3` / `6957b075` (`workflow_runtime_drift`).
- **Ref drift** — §2a ref missing at dispatch time, resolving to any SHA other than `8582652e6f4f73191389360e2a77529d46a73bc9`, moved after verification, or accompanied by any other new/modified ref.
- **SHA drift** — `candidate_sha` ≠ `7bdc3cbc…` (`stale_sha`) or equal to the host (`host_candidate_not_distinct`).
- **Attempt drift** — run attempt ≠ 1 (`retry_attempt`), or any re-run of the new run.
- **Baseline drift** — dispatch-event count ≠ 1 before the dispatch or ≠ 2 after; any re-run, deletion, or alteration of the spent run `32257803101`; any run appearing between verification and dispatch that is not the authorized dispatch.
- **Pre-state drift** — any all-off check (§4) fails or cannot be evidenced. Actions executed steps in every post-recovery run; a zero-step / `runner_id=0` fingerprint identical to the outage would be an environment-class failure — which still stops the path and returns to CTO triage, never a re-dispatch.
- **Destination drift** — dispatch would touch production, a deployment target, or require a credential, provider write, or any ref mutation.
- **Contract failure** — `malformed_contract`, `workflow_host_mismatch`, `gate_not_required`, manifest-sha mismatch, or any later controller step failing.
- **Evidence failure** — run evidence/artifacts cannot be captured or retained (hard fail, not a retry trigger).
- **Rollback failure** — post-trial readback cannot be evidenced (missing/malformed rollback record → hard fail).

A failed attempt — of any class — is never re-dispatched under this authorization; failure returns to CTO triage.

## 7. Evidence path

- Operator: `operator-evidence` document on **STA-2404** (evidence schema `stay-digital-hs-visual-gate-evidence/v2`), plus GitHub run artifacts via `actions/upload-artifact`; local bundle `artifacts/STA-2404/` in the control-plane workspace with SHA256SUMS. **Bundles are produced untruncated** — the QA-flagged rev-2 defect (`manifest-auth.json` cut at 4,000 bytes, invalid JSON tail) is repaired for the record (deterministic reconstruction from the frozen manifest, original preserved, `artifacts/STA-2282/rev2/manifest-auth-repair.md`, 25/25 checksums OK) and must not recur.
- Retention: 7 days pass / 30 days failure.
- Independent verification: durable PASS/FAIL report by QA on the new verification issue using the shared QA template; local contract tests alone are insufficient.

## 8. Rollback (fail-closed; missing or malformed rollback = hard fail)

**Trial level** — the gate is enabled only via the single dispatch input; after the single run it is off by construction. Read back and record that no persistent requirement exists (`visualGate.required=false` state). On failure: retain evidence 30 days. No fallback dispatch, baseline update, provider write, credential change, or production action as recovery.

**Ref level** — after the verifier's verdict is recorded, the board operator may delete `refs/heads/visual-gate/sta-2282-8582652e` (readback recorded); deletion is authorized cleanup, not a PASS requirement. Until then the branch stands as the dispatch provenance anchor. Agent principals never mutate it.

**Repository level** (unchanged) — revert `8582652e6f4f…`, then `ff593d26ec4…`, then `abd702496294…` (reverse delivery order); rerun `node --test .github/workflows/hs-visual-regression.test.mjs`.

## 9. Machine-readable manifest

Revision 1 attachment `5424b10e-1a8c-4108-8fc5-755192cd4971` (SHA-256 `3a641e14…`) remains the manifest of record for all frozen objects; revision 3's deltas are exactly: the spent rev-2 authorization record and STA-2283 environment-class FAIL as basis (§1), the count baseline 1→authorizes-one-additional (§2, §4.1, §6 baseline-drift clause), §2a restated from create-once to already-exists/no-mutation, operator issue STA-2282→STA-2404, verifier issue STA-2283→new QA issue, the §7 untruncated-bundle requirement, and the post-outage failure-classification note. Workspace copy: `artifacts/STA-2281/trial-authorization-manifest.json`.

## 10. What acceptance of this revision authorizes — and nothing more

1. Exactly **one additional** non-production `workflow_dispatch` of workflow `272513204` on `stayinsured/web-platform` at the existing named ref `visual-gate/sta-2282-8582652e` (which must still resolve to `8582652e6f4f…`), inputs `candidate_sha=7bdc3cbca394da29a7148b4ba6505826a360d07d` and `visual_gate_required=true`, run attempt 1, executed by the named operator under STA-2404 under the named stop conditions with the named evidence and rollback; and
2. Post-verifier deletion of the §2a branch by the board operator as optional cleanup (§8 ref level).

No ref creation, move, or deletion is authorized or required from the operator under this revision. STA-2404 holds at in_progress pending this confirmation's acceptance; the dispatch occurs only after acceptance is on record. A second dispatch, a re-run at attempt > 1, any ref mutation by an agent principal, or any other excluded mutation requires a new, separately accepted revision.
