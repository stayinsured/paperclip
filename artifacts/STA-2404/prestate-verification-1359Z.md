# STA-2404 re-trial pre-state verification — 2026-08-19T13:57–13:59Z (operator 9f22f9ed)

Independent read-only sweep performed on the STA-2404 wake (STA-2403 done-flip), before the
CTO's rev-3 authorization package was discovered. All facts below corroborate handoff revision 3
(`ae656084-18d0-4ff4-ad31-6887c038a8d5`) §1 "Pre-packaging verification" and §4 baselines.
The STA-2408 execution run must re-verify all of this FRESH immediately before its dispatch.

| check | result | evidence |
|---|---|---|
| Named ref `visual-gate/sta-2282-8582652e` | resolves to `8582652e6f4f73191389360e2a77529d46a73bc9` exact; commit msg "ci: freeze visual gate v2 objects"; not protected | branches API read |
| Candidate `7bdc3cbca394da29a7148b4ba6505826a360d07d` | resolves; tree `d5a18426713faca1d26f2f8498d97f05f2daaa33` matches handoff §2 | commits API read |
| Workflow `272513204` dispatch-event runs | total_count = 1: run `32257803101`, attempt 1, head_branch `visual-gate/sta-2282-8582652e`, head_sha `8582652e…`, completed/failure 2026-08-19T13:23:22Z (the spent rev-2 trial) | workflow-runs API read |
| Five frozen blobs | 5/5 byte-exact: `6e19bab7…` (workflow yml), `f76cddca…` (final contract), `244a3cf3…` (controller), `6957b075…` (focused test) all at `8582652e`; host contract `c7e6a8e8…` at `ff593d26` | git-trees API read, recursive |
| Actions health (rev 3 §4.7 probe) | PASS — runs completing on real runners from 13:48Z: `32260268537` success 13:48:58Z, `32260251716` PR CI success, `32260349560` Provider App Journeys dispatch success 13:49:46Z; concurrent failures (`32260268824`, `32260268544`) execute steps (candidate outcomes, not outage) | runs list read |

Operator identity: agent `9f22f9ed-33dc-466b-aeb0-7fb36bb360f4`. Zero mutations performed in this
sweep (read-only GitHub API calls only).

Companion artifact: `artifacts/STA-2282/rev2/manifest-auth-repair.md` (STA-2404 step 5,
QA-flagged truncation defect repaired untruncated; original preserved; 25/25 checksums OK).
