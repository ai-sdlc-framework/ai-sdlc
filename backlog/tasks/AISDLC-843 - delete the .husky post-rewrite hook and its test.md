---
id: AISDLC-843
title: >-
  delete the .husky/post-rewrite hook and its test
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - hooks
  - velocity
dependencies: []
references:
  - .husky/post-rewrite
  - scripts/post-rewrite-hook.test.mjs
  - scripts/check-orchestrator-state.sh
  - docs/operations/doctor.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`.husky/post-rewrite` cannot act in the steady state it exists for: it returns early when the parent has `main` checked out, and the parent must be on `main` at all times (AISDLC-358); worktrees run their own hooks (`docs/audits/2026-10-13-cicd-five-step-audit.md`, finding F9). It still costs a test (`scripts/post-rewrite-hook.test.mjs`, wired into `test:orchestrator-state-gate`), a shim-repointing branch in `scripts/check-orchestrator-state.sh` (AISDLC-750) and a doctor check (`worktree-rewrite-hooks`).

**Five-step review (requirements first).** Requirement questioned: "a post-rewrite hook protects the parent's main ref after a rebase" (AISDLC-708 and AISDLC-750), made obsolete by the AISDLC-358 guard that keeps the parent on main. The operator answered DEC-0164 on 2026-10-13 (option `delete`). Delete: the hook, its test, the shim repointing in `scripts/check-orchestrator-state.sh` and the `worktree-rewrite-hooks` doctor check. Simplify: one fewer hook to generate per worktree. Accelerate: not applicable. Automate: nothing new.

## Fix

1. Delete `.husky/post-rewrite` and `scripts/post-rewrite-hook.test.mjs`; remove the test from the `test:orchestrator-state-gate` script in `package.json`.
2. In `scripts/check-orchestrator-state.sh` (and its parity copy under `ai-sdlc-plugin/scripts/`) delete the post-rewrite shim repointing; update `scripts/check-orchestrator-state.test.mjs` (the AISDLC-750 case) and the parity test.
3. Delete the `worktree-rewrite-hooks` check from `orchestrator/src/cli/commands/doctor-checks.ts` with its test, and its row in `docs/operations/doctor.md`.
4. Remove any `.ai-sdlc/gates.yaml` entry for it. `rg -n "post-rewrite" .` returns only historical documents.

**Velocity impact.** Positive: one hook fewer per worktree and per rebase; it could not act in the required parent state.

Authority: DEC-0164 (answered 2026-10-13, operator present; record lands on main via the decisions-sync PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.husky/post-rewrite` and its test no longer exist and `test:orchestrator-state-gate` does not reference them
- [ ] #2 `check-orchestrator-state.sh` and its plugin parity copy no longer touch post-rewrite shims and their tests pass
- [ ] #3 The `worktree-rewrite-hooks` doctor check and its docs row are removed
- [ ] #4 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
