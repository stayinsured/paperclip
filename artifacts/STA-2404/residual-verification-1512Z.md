# STA-2404 residual-scope verification — 2026-08-19T15:12Z

Trigger: STA-2408 done-flip 15:07:12Z (single rev-3 dispatch executed, run
`32267409007` attempt 1 terminal failure, package-inherent defect; evidence
`artifacts/STA-2408/` @ commit `18ae320c5`, operator-evidence rev `c19c0c42`).

Residual scope (CTO consolidation 14:01Z + this issue's unblock descriptor):
row 1 = QA-flagged truncation defect must not recur in STA-2408's evidence path
(full-file readback); row 2 = confirm the CTO opened the fresh independent QA
verifier issue after terminalization.

## Row 1 — no truncation recurrence in the rev-3 evidence path: PASS

Verified fresh at 15:08–15:12Z against `artifacts/STA-2408/` as pushed
(`18ae320c5`):

- **Top-level `SHA256SUMS`: 32/32 OK** (`sha256sum -c`), 32 checksum entries =
  32 files on disk — full coverage, no unmanifested file, no boundary-length
  file (zero files at 4,000 B or other truncation sizes).
- **All 19 JSON captures parse as complete JSON** (largest
  `dispatch-runs-final.json` 1,312,499 B; `wf-runs-all.json` 1,313,510 B) —
  no invalid tail anywhere.
- **Nested failing-evidence bundle intact:** `failing-evidence/evidence/SHA256SUMS`
  2/2 OK (`credential-scan.json`, `hs-visual-gate-run-evidence.json`);
  `artifact-9370771556.zip` 3 entries, `testzip()` clean;
  `hs-visual-gate-run-evidence.json` (3,382 B) carries the full top-level
  block set (activity/candidate/conclusion/counters/failures/gate/manifest/
  playwright/run/runtime/schemaVersion/sourceDigests/workflow/workflowHost).
- **Manifest-of-record binding (structural fix, stronger than rev-2):** the
  rev-3 path does not capture a `manifest-auth.json` excerpt at all —
  operator-evidence §4.4 binds the full manifest of record
  `artifacts/STA-2281/trial-authorization-manifest.json` by complete-file
  sha256 `3a641e147d1362ad9c85f73eb0b4c1e8b1c5c2135ef302359a3d3ab6d626b4a6`
  (byte-exact vs frozen), with the auth block values recorded
  (`releaseGateActivation=disabled`, `productionDeployment=not-authorized`,
  `externalProviderWrites=not-authorized`). A full-file digest cannot be
  truncated, so the rev-2 defect class (4,000 B excerpt cut) is structurally
  closed, not merely not-observed.
- Rev-2 record repair itself remains in place:
  `artifacts/STA-2282/rev2/manifest-auth.json` 10,643 B valid JSON
  (commit `46fe7fb2`), original preserved as
  `manifest-auth.json.truncated-4000B.orig`.

## Row 2 — fresh independent QA verifier issue: NOT YET CREATED (CTO action pending)

Probe at 15:09–15:12Z: no verifier issue exists. Direct identifier probe
STA-2409…STA-2413 — newest issue is STA-2412 (15:03:41Z, HFS intake,
unrelated); STA-2413 unassigned. No CTO triage comment on STA-2276 (last
2026-08-18), STA-2282 (last 13:28Z), or STA-2408 after the 15:07Z terminal
record. STA-2276 remains blocked on STA-2293 (blocked).

Liveness gap, same class the chain hit at 13:01Z on STA-2282 ("blocked state
had no wake path to the CTO"): STA-2408 is done (no further runs fire on it),
STA-2282/STA-2283 are done, STA-2276 is blocked on an unrelated edge — so the
CTO's §5 obligations (open the fresh independent verifier issue; triage the
package defect) have no first-class wake. Closed here by delegated follow-up
issue (assignee CTO `805da696`) with STA-2404 blocked on it; STA-2404 closes
on that issue's resolution after confirming the verifier issue exists.

## Commands (read-only, run from `artifacts/STA-2408/`)

    sha256sum -c SHA256SUMS                     # 32/32 OK
    find . -type f | wc -l                      # 33 incl. SHA256SUMS
    for f in $(find . -name '*.json'); do python3 -m json.tool "$f" >/dev/null; done
    (cd failing-evidence && sha256sum -c evidence/SHA256SUMS)   # 2/2 OK
    python3 -c "import zipfile; zipfile.ZipFile('failing-evidence/artifact-9370771556.zip').testzip()"
