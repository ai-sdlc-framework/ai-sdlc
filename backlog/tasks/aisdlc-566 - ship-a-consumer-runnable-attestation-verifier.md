---
id: aisdlc-566
title: Ship a consumer-runnable v6 attestation verifier
status: To Do
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

- [ ] A verifier reachable from a consumer repo (plugin-shipped script or
      `cli-attestation verify` subcommand) that returns a correct pass/fail on a
      v6 DSSE envelope + committed transcript leaves, with no monorepo-relative
      `../orchestrator/dist` import.
- [ ] Runtime resolution mirrors the signer's candidate walk (published package
      export / node_modules walk-up / plugin dirs), with a minimum-version guard.
- [ ] Documented, copy-pasteable adopter CI recipe for the verify step against a
      committed operator public key.
- [ ] `.github/workflows/verify-attestation.yml` in this repo still passes
      (no regression to the in-repo verifier).
- [ ] Hermetic test proving the verifier resolves and verifies from a
      node_modules-style install layout (not just the in-repo checkout).
