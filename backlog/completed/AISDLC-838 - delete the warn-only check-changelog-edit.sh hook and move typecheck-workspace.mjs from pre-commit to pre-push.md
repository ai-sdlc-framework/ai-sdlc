---
id: AISDLC-838
title: >-
  delete the warn-only check-changelog-edit.sh hook and move
  typecheck-workspace.mjs from pre-commit to pre-push
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
  - .husky/pre-commit
  - scripts/typecheck-workspace.mjs
  - .ai-sdlc/gates.yaml
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
drift_log:
  - date: '2026-10-13'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/check-changelog-edit.sh'
    resolution: flagged
drift_checked: '2026-10-13'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Two local hooks cost time for little value (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 rows D10 and D11):

- `scripts/check-changelog-edit.sh` (origin: AISDLC-401) is warn-only and called from `.husky/pre-push`. release-please owns `CHANGELOG.md` and a stray edit conflicts on the release PR; the problem it guarded against has not recurred since its introduction in AISDLC-401.
- `.husky/pre-commit` runs `node scripts/typecheck-workspace.mjs` on every commit. It is the slowest pre-commit step and fails in fresh worktrees (DEC-0026); a dev round makes several commits and one push, so N-1 typechecks per round are wasted.

**Five-step review (requirements first).** Requirement questioned: "warn when a feature branch edits CHANGELOG.md" (the changelog-check task) and "typecheck the workspace on every commit" (origin unknown per the registry). The operator answered DEC-0103 (delete) and DEC-0104 (move) on 2026-10-11. Promoting the changelog warning to a failing gate was rejected. Delete: `check-changelog-edit.sh`, its call, its test and the CLAUDE.md/docs sentence about it. Simplify: workspace typecheck runs at push time only, where `pnpm build` already runs the typecheck. Accelerate: commit is fast again and the fresh-worktree commit failure disappears. Automate: nothing new.

## Fix

1. Delete `scripts/check-changelog-edit.sh` and its call (and the `AI_SDLC_SKIP_CHANGELOG_CHECK` mention) in `.husky/pre-push`; delete any test file that exists only for it and fix `scripts/check-followups.test.mjs` if it references the script.
2. Remove `node scripts/typecheck-workspace.mjs` from `.husky/pre-commit`; add it to `.husky/pre-push` (after the cheap static gates, before the fixups orchestrator). Keep `scripts/typecheck-workspace.mjs` and its test (`test:typecheck-workspace-gate`).
3. `.ai-sdlc/gates.yaml`: delete `pre-push:scripts/check-changelog-edit.sh`; change `pre-commit:scripts/typecheck-workspace.mjs` to `pre-push:scripts/typecheck-workspace.mjs` (a move is not an addition; keep the entry's origin and owner and update its id and surface so the registry test is satisfied).
4. Docs: CLAUDE.md "Hooks" pointer line, `docs/operations/release-flow.md` and `release-and-plugin-reference.md` (changelog warning removed; state that release-please owns CHANGELOG.md and a stray edit surfaces as a release-PR conflict), `docs/operations/pre-push-and-ci-reference.md`.
5. This task and the pre-push dedupe task both edit `.husky/pre-push`; rebase onto main before pushing and resolve by keeping both changes.

**Velocity impact.** Positive: a commit no longer runs a workspace typecheck (the slowest pre-commit step) and one warn-only script leaves every push.

Authority: DEC-0103 (answered 2026-10-11, on main).
Authority: DEC-0104 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `scripts/check-changelog-edit.sh` is deleted and `.husky/pre-push` no longer calls it
- [ ] #2 `.husky/pre-commit` no longer runs `typecheck-workspace.mjs`; `.husky/pre-push` runs it once
- [ ] #3 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #4 A hermetic test or the existing `test:typecheck-workspace-gate` proves the typecheck still fails a push on a type error
- [ ] #5 CLAUDE.md pointer line and docs/operations pages named in the Fix no longer mention the changelog hook and state where the typecheck runs
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
