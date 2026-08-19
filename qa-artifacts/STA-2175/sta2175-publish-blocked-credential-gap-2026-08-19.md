# STA-2175 — Stage-2 publish attempt at revision-6 `2e83d856`: blocked on HubSpot credential type (2026-08-19 ~14:50Z)

**Verdict: BLOCKED (credential scope gap, proven) — not a candidate failure. Nothing published; live sandbox untouched at the recorded baseline; production untouched; no rollback required.**

## 1. Context: why this run attempted publication

- Wake `issue_blockers_resolved`: STA-2402 (WPE) flipped `done`. Its final report (13:48:53Z) names the publish identity of record: **`2e83d8560e186e2f274d7abc1937bb506e5cbff8` / tree `77f703673c2671a1574dd7942ae3d278b9f149a0`** on `ops/sta-2402-revision-6-candidate`, and states "the tree to bind for publish remains `2e83d85`" (dev parity proven byte-level; 3 differing files are dev-side newer — a squash merge would revert them).
- QA pre-publication PASS at exactly this SHA stands (run c2d11189, `sta2175-rev6-prepublication-2026-08-19.md`): identity, containment (1 line vs rev-5 tree), install, Chromium, `preflight:sentry:test`, **`preflight:visual` 97/0**, `build-ui`, marker resolution.
- Actions admission is **restored** (PR CI runs executing steps and green 14:12–14:22Z) — but see §3.

## 2. Pre-publish identity refresh (this run, all recorded)

| Check | Result |
|---|---|
| Branch tip (git ls-remote) | `ops/sta-2402-revision-6-candidate` = `2e83d8560e…` — **exact match** (dev `8915c156`, main `f5ece242`) |
| Portal identity (`account-info/v3/details`, QA principal) | **148038858 / SANDBOX**; denylist `145845089` never contacted; `HUBSPOT_QA_ALLOW_PRODUCTION=false` |
| Fresh rollback baseline (cache-busted) | `/`, `/about-us`, `/pension`, `/health-insurance`, `/contact-us` all 200, uniform marker `hubspot-dev-5be78c3336e152d38b8f433b32c13228d1cebef3`, per-route sha256 in `publish-run/` — **baseline moved a 4th time today** (`6260d879`→`be67acb8`→`9eea0091`→`5be78c33`) |
| Manifest at main `f5ece242` | SHA-256 `44588bcf…b25`, still binds **rev-5 `9681a4a0`** → protected dispatch cannot carry rev-6 without a main re-bind |
| Clean clone | HEAD `2e83d8560e…` / tree `77f70367…` verified at clone time; worktree clean before build |

## 3. Publication path decision

- Protected workflow dispatch is **not available** for rev-6: the STA-2172 manifest at protected `main` binds `9681a4a0` (rev-5); dispatching any other `release_ref` stops on the workflow's own identity gate. A re-bind is a protected-main PR (CTO/board action, STA-2355 precedent).
- Operative path per the user's standing 13:05Z direction ("run the pipelines locally") and the 13:12Z in-thread plan: local workflow-faithful build + `hs project upload` with the QA sandbox principal.

## 4. Build at the exact SHA (workflow-faithful; `publish-run/build-chain.log`)

- `pnpm@10.20.0 install --frozen-lockfile` — PASS (1102 pkgs)
- `build-ui` (with the workflow's provider-SHA-unset wrapper, `HS_ENV=dev`) — PASS
- `generate-profile:dev` with `HUBSPOT_DEPLOYED_GIT_SHA=2e83d8560e…` — PASS; marker `hubspot-dev-2e83d8560e186e2f274d7abc1937bb506e5cbff8` resolved in `src/app/release-manifest.json`, `src/app/cards/referral-program-config.js`, both `base.hubl.html`/`no-footer.hubl.html` layouts
- Sentry/visual gates not re-run: same immutable SHA, PASS recorded 14:26Z (cited, not hidden). Sentry env supplied with identical provenance as the prior run (public client DSN from the live page, `environment=test`, `.env.example` sample rates).
- Residual: Node v24.19.0 vs workflow Node 20 (same as prior runs; no attributable failure).

## 5. The upload failure — exact evidence

Pinned HubSpot CLI 8.0.0 installed (same as workflow step), exact workflow invocation used (`upload --force-create --use-env --json --message "Exact sandbox candidate 2e83d856…" --profile dev`, `working-directory: packages/hubspot`, env `HUBSPOT_ACCOUNT_ID=148038858` + `HUBSPOT_PERSONAL_ACCESS_KEY=<QA sandbox token>`):

```
[ERROR] The request was unauthorized. … Failed to sign refresh token because refresh
token was malformed and could not be decoded. Generate a new refresh token and try again.
```

Root cause (verified in installed CLI code, `@hubspot/local-dev-lib`):
- CLI 8.0.0 PAK auth **exchanges** the env key by posting `{encodedOAuthRefreshToken: <key>}` to `localdevauth/v1/auth/refresh` (`utils/personalAccessKey.js`). It requires a **local-dev personal access key**.
- The QA principal's `HUBSPOT_QA_SANDBOX_ACCESS_TOKEN` is a `pat-eu1-…` private-app token: valid API Bearer (account-info 200) but **not** a local-dev key → exchange rejected.
- Direct API probes with the same Bearer: `GET developer/projects/v1` (list) and `GET developer/projects/v1/by-name/stay-theme` → **403 `MISSING_SCOPES` — "The scope needed for this API call isn't available for public use"**. The projects scope is not grantable to private-app tokens at all.

**Conclusion:** `hs project upload` requires a credential type the QA principal does not hold: a local-dev personal access key for portal 148038858 (what CI stores as `HUBSPOT_DEV_PERSONAL_ACCESS_KEY`). Copying CI's key into the QA lane would violate the principal-specific credential rule and was not attempted.

## 6. Self-serve remedy attempted and unavailable this run

Creating a QA-principal local-dev key in sandbox portal settings is an authenticated-UI-only action (no API). Browser lease attempted per skill:

- `browser-lease shared.create` → refused: "Sealed browser profile already has an active lease" (held by another session)
- `browser-lease auth.restore` → "No active lease" (none bound to this run); all control subcommands → "No attached control"
- Serialized control honored — no takeover attempted.

## 7. Consequences

- **Nothing was uploaded.** Live sandbox remains at `hubspot-dev-5be78c33…` (§2 baseline). Production, forms, CRM/workflows, consent, analytics, Intercom untouched.
- Functional mobile/desktop matrix and LCP bounded-request gates: **not run** (they require the candidate live).
- Everything is staged for a minutes-long publish once the credential exists: clean clone + verified build + marker at the exact SHA, pinned CLI 8.0.0, exact invocation, fresh rollback baseline.
- Side action: **stayinsured/web-platform#190 closed** (this run, as author) — STA-2402's parity evidence shows merging it would revert 3 dev-side improvements; publish identity remains the `ops/*` branch SHA.

## 8. Unblock owners and actions (ranked)

1. **QA self-serve (primary, no external dependency):** at next wake with the browser lease free, create a QA-principal local-dev key (`qa-sta2175-publish`) in portal **148038858** settings via the lease, then upload → readback (buildId/deployId + live marker `hubspot-dev-2e83d856…` on all 5 routes) → full validation matrix. Task-scoped authority: this issue assigns QA the protected sandbox publish step.
2. **DevOps/CTO fallback (credential):** provision a QA-principal local-dev key into the QA env (never copy CI's `HUBSPOT_DEV_PERSONAL_ACCESS_KEY`).
3. **CTO fallback (canonical protected path):** land a STA-2172 manifest re-bind to `2e83d856` on protected `main` and dispatch the protected workflow — **Actions admission is restored** (PR CI green with executed steps 14:12–14:22Z).
