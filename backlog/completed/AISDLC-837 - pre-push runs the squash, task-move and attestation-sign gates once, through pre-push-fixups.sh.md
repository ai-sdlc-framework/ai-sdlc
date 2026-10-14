---
id: AISDLC-837
title: >-
  pre-push runs the squash, task-move and attestation-sign gates once, through pre-push-fixups.sh
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - hooks
  - velocity
dependencies: []
references:
  - .husky/pre-push
  - scripts/pre-push-fixups.sh
  - scripts/squash-attestation-chores.sh
  - scripts/check-task-moved.sh
  - scripts/check-attestation-sign.sh
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`.husky/pre-push` calls `scripts/squash-attestation-chores.sh` on its own, then `scripts/pre-push-fixups.sh` (which runs `check-task-moved.sh` then `check-attestation-sign.sh` in order), then calls `check-task-moved.sh` and `check-attestation-sign.sh` again directly as "defense-in-depth". Each gate runs twice per push; the squash origin is AISDLC-369, the orchestrator AISDLC-386 (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 row D9). On the re-push after a fixup the second call is a no-op by design, so the duplicate buys nothing.

**Five-step review (requirements first).** Requirement questioned: "keep the individual hook calls as defense-in-depth" (AISDLC-386 comment in `.husky/pre-push`). The operator answered DEC-0102 on 2026-10-11: full dedupe. Delete: the two direct calls of `check-task-moved.sh` and `check-attestation-sign.sh` in `.husky/pre-push`. Simplify: fold `squash-attestation-chores.sh` into `pre-push-fixups.sh` so one orchestrator runs squash, task-move, attestation-sign in order. Every gate still runs, once; hermetic tests prove the single path signs and verifies. Accelerate: one fewer idempotency pass per push. Automate: nothing new.

## Fix

1. `scripts/pre-push-fixups.sh`: add the squash step first (before task-move, which is before attestation-sign; the load-bearing order from the existing header comment is preserved), honouring `AI_SDLC_SKIP_SQUASH_CHORES=1`.
2. `.husky/pre-push`: delete the standalone `squash-attestation-chores.sh` call and the two direct `./scripts/check-task-moved.sh` / `./scripts/check-attestation-sign.sh` lines; rewrite the header comment to describe one orchestrator.
3. Update `scripts/check-attestation-sign.test.mjs` and the `test:pre-push-fixups-gate` tests to assert: a push needing a squash, a task move and a signature completes in one orchestrator pass and the following push is clean; `AI_SDLC_BYPASS_ALL_GATES=1` and each `AI_SDLC_SKIP_*` var still work.
4. `.ai-sdlc/gates.yaml`: delete the `pre-push:scripts/squash-attestation-chores.sh` entry if the script is inlined or no longer chained directly from `.husky/pre-push`, and any direct-call entries, keeping the `pre-push-fixups.sh` entry.
5. Docs: CLAUDE.md "Hooks" pointer line, `docs/operations/pre-push-and-ci-reference.md`, `emergency-bypass.md`, `attestation-reference.md`.

**Velocity impact.** Positive: removes a duplicate pass of two gates on every push; each gate still runs.

Authority: DEC-0102 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.husky/pre-push` invokes `pre-push-fixups.sh` once and contains no direct call of `check-task-moved.sh`, `check-attestation-sign.sh` or `squash-attestation-chores.sh`
- [ ] #2 `pre-push-fixups.sh` runs squash, task-move, attestation-sign in that order and the existing skip and bypass env vars still work
- [ ] #3 Hermetic tests prove a single pass signs and verifies and the re-push is clean
- [ ] #4 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #5 CLAUDE.md pointer line and the docs/operations pages named in the Fix describe the single orchestrator
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
