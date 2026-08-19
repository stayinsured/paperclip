# STA-2175 — QA pre-publication (stage 1) at revision-6 candidate SHA 2e83d856

- Date: 2026-08-19 (run c2d11189-664f-47b8-93c4-b3303e99e30c)
- Candidate: `2e83d8560e186e2f274d7abc1937bb506e5cbff8` (tree `77f703673c2671a1574dd7942ae3d278b9f149a0`), branch `ops/sta-2402-revision-6-candidate`, parent `6260d879` (same base as revision-5 `9681a4a`)
- Board authority: decision of 2026-08-19 13:33Z on STA-2175 — option 1 (revision-6 = revision-5 repair + spec import fix)
- PR advancing the landing: stayinsured/web-platform#190 (base `dev`), opened by QA; merge stays with STA-2402 owner / CTO

## Verdict: PASS — all pre-publication gates pass at 2e83d856

| Gate (workflow order, `hubspot-exact-sandbox-deploy.yml`) | Result |
|---|---|
| Identity: clone HEAD vs GitHub API (sha + tree) | PASS — `2e83d856…` / `77f70367…` identical |
| Containment vs approved rev-5 tree `8efeecd3…` | PASS — exactly 1 changed file, 1 line: spec import `.mjs` → `.js` (`rev6-containment.diff`) |
| `pnpm install --frozen-lockfile` (pnpm 10.20.0) | PASS |
| Playwright Chromium (no `--with-deps`; system deps present) | PASS |
| `preflight:sentry:test` | PASS (2nd attempt, see env provenance) |
| `preflight:visual` | **PASS — 97 passed / 0 failed (1.5m)**, incl. `responsive-image-request.spec.ts`: one selected transfer, bounded 2x transfer, per-route bounded hero requests (mobile+desktop) |
| `build-ui` | PASS |
| `generate-profile:dev` | PASS — marker `hubspot-dev-2e83d8560e186e2f274d7abc1937bb506e5cbff8` resolved in `src/app/release-manifest.json`, `SENTRY_RELEASE`, `base.hubl.html`, `no-footer.hubl.html` |

Full log: `rev6-pipeline-local.log`. Nothing was uploaded; sandbox and production untouched.

## Read-only sandbox context captured this run

- Portal identity: `148038858`, accountType `SANDBOX` (`rev6-account-info.json`); production denylist `145845089` never contacted.
- Live rollback baseline (fresh, cache-busted; `rev6-prestate-baseline.txt`): `/`, `/about-us`, `/pension`, `/health-insurance`, `/contact-us` all HTTP 200, single uniform marker `hubspot-dev-9eea00912c1311f39dd65321b7b34ba4f85a5e32` (= current dev tip, published ~13:49Z). Baseline moved 3× today (`6260d879` → `be67acb8` → `9eea0091`), confirming baseline capture must be repeated at publish time.

## Environment provenance and residual gaps (stated, not hidden)

1. Local run uses Node v24.19.0 vs workflow Node 20 (same as the previous 9681a4a run). All failures encountered were missing env inputs, resolved below; no Node-version-attributable failure observed.
2. First `preflight:sentry:test` attempt failed for missing `VITE_SENTRY_DSN`/`VITE_SENTRY_ENVIRONMENT` (workflow supplies them from GitHub environment config). Supplied as: public client Sentry DSN + environment `test` extracted from the live sandbox page's public client config; sample rates from the committed dev defaults in `packages/hubspot/.env.example`.
3. `generate-profile:dev` inputs taken from the candidate tree's own committed `packages/hubspot/src/hsprofile.dev.json` (accountId `148038858` matches the verified sandbox portal; backend `https://hs-forms-api-test.stayinsured.de` corroborated by `HFS_STAGING_URL`).
4. Gap: this PAT cannot read GitHub repo *variables* (403). If workflow-time variables differ from the candidate-committed dev profile values, the workflow-built artifact could differ in those constants only (not in candidate source). Compensating control for stage 2: post-publish readback of marker, routes, and rendered behavior.
5. Chromium installed without `--with-deps` (container constraints); system dependencies were present and the full visual suite ran green.

## Next (stage 2, pending one action)

On merge of #190 to `dev` (reported SHA + tree), QA re-runs this exact gate suite at the landed SHA, then publishes through the protected sandbox path and runs the full mobile 390×844 DPR 2 / desktop 1440×900 DPR 1 functional + LCP bounded-request validation per the issue scope. Publishing the branch SHA directly was considered and is not recommended: the branch is 136 commits behind `dev`, so it would regress sandbox content below today's dev tip.
