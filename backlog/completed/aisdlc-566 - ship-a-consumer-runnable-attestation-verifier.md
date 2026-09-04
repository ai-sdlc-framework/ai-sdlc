---
id: aisdlc-566
title: Ship a consumer-runnable v6 attestation verifier
status: Done
priority: high
labels:
  - attestation
  - adoption
  - proof-of-execution
drift_status: flagged
drift_checked: '2026-09-04'
drift_log:
  - date: '2026-09-04'
    type: ref-deleted
    detail: 'Referenced file no longer exists: AISDLC-554'
    resolution: flagged
  - date: '2026-09-04'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
---

## Description

AISDLC-554 made the attestation **signer** reachable in adopter/consumer repos
(runtime resolved via `nodeModulesWalkUp` + `$CLAUDE_PLUGIN_DIR`/`$CLAUDE_PLUGIN_ROOT`,
and `orchestrator/package.json` now exports `./runtime`). But the **verifier**
side was not addressed: a consumer repo can now *sign* a v6 attestation yet has
**no first-party, CI-runnable way to independently re-verify** it.

Root cause (verified at `main`):
- `scripts/verify-attestation.mjs` — the pass/fail DSSE verifier this repo's CI
  uses — is **not shipped in the plugin** (`ai-sdlc-plugin/scripts/` contains only
  `init-signing-key.mjs`, `sign-attestation.mjs`, `sign-attestation.test.mjs`).
- It also has a static, monorepo-relative import that only resolves inside this
  checkout: `scripts/verify-attestation.mjs:476` →
  `'../orchestrator/dist/runtime/attestations.js'`.
- `pipeline-cli`'s `cli-attestation` bin exposes only inspection subcommands
  (`merkle-root`, `merkle-proof`, `transcripts list`), not a full envelope verify.

Surfaced by the consumer-repo Proof-of-Execution report (#976). This task covers
the verifier gap only; the *independence-semantics* concern from that issue is
tracked separately (see [[aisdlc-560]], [[aisdlc-561]], [[aisdlc-562]]).

## Scope

1. Package a consumer-runnable verifier in the plugin (either ship
   `verify-attestation` under `ai-sdlc-plugin/scripts/`, or expose an equivalent
   `cli-attestation verify` subcommand) that resolves the v6 runtime the same way
   `sign-attestation.mjs` does — via the published `@ai-sdlc/orchestrator/runtime`
   export and the ordered candidate walk — instead of the monorepo-relative
   `../orchestrator/dist/...` import.
2. Provide a documented CI recipe an adopter can drop into their own workflow to
   verify a committed DSSE envelope against a committed operator public key, so
   the verify step does not depend on this monorepo's `scripts/` + sibling
   `orchestrator/dist/`.
3. Keep this repo's own `scripts/verify-attestation.mjs` working (its
   `.github/workflows/verify-attestation.yml` usage must not regress).

## Acceptance Criteria

- [x] A verifier reachable from a consumer repo (plugin-shipped script or
      `cli-attestation verify` subcommand) that returns a correct pass/fail on a
      v6 DSSE envelope + committed transcript leaves, with no monorepo-relative
      `../orchestrator/dist` import.
- [x] Runtime resolution mirrors the signer's candidate walk (published package
      export / node_modules walk-up / plugin dirs), with a minimum-version guard.
- [x] Documented, copy-pasteable adopter CI recipe for the verify step against a
      committed operator public key.
- [x] `.github/workflows/verify-attestation.yml` in this repo still passes
      (no regression to the in-repo verifier).
- [x] Hermetic test proving the verifier resolves and verifies from a
      node_modules-style install layout (not just the in-repo checkout).

## Final summary

Shipped `ai-sdlc-plugin/scripts/verify-attestation.mjs`, a consumer-runnable
counterpart to `scripts/verify-attestation.mjs` (the in-repo CI verifier).

- Extracted the entire v6/v5/v4/v3 verification core (Merkle primitives,
  head-binding relaxations, content-hash matching, `runVerifier`) out of
  `scripts/verify-attestation.mjs` into a new shared module,
  `ai-sdlc-plugin/scripts/verify-attestation-core.mjs`. Zero behavioural
  changes — every function is byte-for-byte identical except the
  `@ai-sdlc/orchestrator` runtime bindings, which moved from a static
  monorepo-relative import to a `bindRuntime()` call the driver makes once.
- `scripts/verify-attestation.mjs` is now a thin driver: it imports the
  shared core, binds it to `../orchestrator/dist/runtime/attestations.js`
  (unchanged path, so `.github/workflows/verify-attestation.yml` keeps
  working with zero regression), and re-exports every named export so the
  existing 5,300-line `scripts/verify-attestation.test.mjs` suite (136
  tests) keeps passing unmodified.
- `ai-sdlc-plugin/scripts/verify-attestation.mjs` is the new consumer-facing
  driver. It resolves `@ai-sdlc/orchestrator` via the SAME candidate-walk
  strategy `sign-attestation.mjs` uses (AISDLC-554): monorepo dev path →
  `node_modules` walk-up from repo root → `$CLAUDE_PLUGIN_DIR`/`$CLAUDE_PLUGIN_ROOT`
  → `node_modules` walk-up from the script's own location, each candidate
  version-gated against a `0.14.0` minimum. CLI surface accepts
  `--head`/`--base` flags or the `PR_HEAD_SHA`/`PR_BASE_SHA` env-var
  contract (mirroring the CI workflow), defaulting to `git rev-parse HEAD`
  / `git merge-base origin/main HEAD` when neither is given. Exit codes:
  0 = valid, 1 = invalid, 2 = usage/environment error.
- Added `docs/operations/adopter-attestation-verify-ci.md` — a
  copy-pasteable GitHub Actions recipe for an adopter repo.
- New hermetic test suite `ai-sdlc-plugin/scripts/verify-attestation.test.mjs`
  (9 tests) proves real sign-then-verify round trips (both v5 and v6
  schemas) entirely against a `node_modules`-style install layout with no
  `orchestrator/` source tree present — plus the failure-mode tests
  (runtime absent, stale version rejected, tampered diff rejected).
  Wired into `pnpm test` as `test:verify-attestation-plugin-gate`.
- Verified `scripts/verify-attestation.test.mjs` (136/136 passing) and
  `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` (30/30 passing) show
  zero regression from the extraction.
