---
id: AISDLC-687
title: >-
  The husky pre-commit workspace typecheck must work in a fresh worktree
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - hooks
  - dx
dependencies: []
references:
  - .husky/pre-commit
  - scripts/typecheck-workspace.mjs
  - scripts/typecheck-workspace.test.mjs
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-directed 2026-10-03. `.husky/pre-commit` runs `pnpm typecheck`
(`pnpm -r --parallel exec tsc --noEmit`). In a freshly created worktree no package has
build output yet. A package that imports a workspace sibling (for example `dogfood`
importing `orchestrator`) resolves the sibling through its built `.d.ts`, so every such import
reports a spurious TypeScript error and the commit is blocked. Contributors and agents then
reach for `git commit --no-verify`, which also bypasses lint-staged and the backlog drift
gate.

## Conventions
- Hermetic `node --test` with a throwaway workspace fixture; no network, no real packages.
- The strict recursive `pnpm typecheck` script stays as it is for CI and manual use.

## Scope
1. **Skip, do not build:** a new `scripts/typecheck-workspace.mjs` type-checks each workspace
   package whose workspace dependencies (transitively) all have their declared entry file on
   disk, and skips the others with one loud line naming the skipped package and the missing
   build output. Skipping was chosen over building: a build takes minutes, writes into the tree
   from a commit hook, and `.husky/pre-push` and CI already build before they check.
2. **Real errors are never hidden:** a package whose upstream build output is present is still
   type-checked, and a package without workspace dependencies is always type-checked.
3. **Hook wiring:** `.husky/pre-commit` calls the runner instead of `pnpm typecheck`.
4. **Test gate:** the runner's test is wired into the root `test` script.
5. **Dark-code gate on push:** `scripts/check-dark-code-on-push.sh` runs `node scripts/check-dark-code.mjs`
   from `.husky/pre-push`, before the coverage gate. It honours `AI_SDLC_BYPASS_ALL_GATES` and its own
   `AI_SDLC_SKIP_DARK_CODE_GATE=1`. The Hooks list in `CLAUDE.md` gets one numbered entry for it
   (the other entries are renumbered).

## Acceptance Criteria
- [x] In a fixture workspace with no build output, the runner exits 0, prints one SKIPPED line per skipped package that names the package and the missing build output, and does not report the unresolved sibling import.
- [x] In a fixture workspace where the upstream build output is present, a real type error in the dependent package makes the runner exit 1.
- [x] A real type error in a package without workspace dependencies still exits 1 when another package is skipped.
- [x] Skipping is transitive: a package depending on a built package that itself depends on an unbuilt one is skipped.
- [x] `.husky/pre-commit` runs `node scripts/typecheck-workspace.mjs` and no longer runs `pnpm typecheck`.
- [x] `node --test scripts/typecheck-workspace.test.mjs` covers each of these.
- [x] A newly dark module makes `scripts/check-dark-code-on-push.sh` exit 1, and a fully wired tree exits 0, in a hermetic fixture repo.
- [x] The dark-code gate is skipped by `AI_SDLC_SKIP_DARK_CODE_GATE=1` and by `AI_SDLC_BYPASS_ALL_GATES=1`.
- [x] `.husky/pre-push` runs the dark-code gate before `scripts/check-coverage.sh`, and `CLAUDE.md` lists it as the first pre-push step.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL-SUMMARY:BEGIN -->
## Summary
The husky pre-commit typecheck no longer fails in a fresh worktree. A new runner type-checks each package whose upstream build output exists and skips the others with one loud line naming the package and the missing output.

## Changes
- `scripts/typecheck-workspace.mjs` (new): the runner (plan, skip notice, per-package tsc).
- `scripts/typecheck-workspace.test.mjs` (new): hermetic fixture tests.
- `.husky/pre-commit` (modified): calls the runner instead of `pnpm typecheck`.
- `package.json` (modified): `test:typecheck-workspace-gate` and `test:dark-code-push-gate`, chained into `test`.
- `scripts/check-dark-code-on-push.sh` and `.test.mjs` (new): the pre-push dark-code gate and its hermetic tests.
- `.husky/pre-push` and `CLAUDE.md` (modified): the gate runs before coverage; one numbered Hooks entry, the rest renumbered.

## Design decisions
- **Skip, not build**: a build takes minutes and writes into the tree from a commit hook; pre-push and CI already build first. Tradeoff: a package is unchecked at commit time until its upstream is built.

## Verification
- `node --test scripts/typecheck-workspace.test.mjs`: 11 passed.
- Real fresh worktree run of the runner: exit 0 with SKIPPED lines.
- `node --test scripts/check-dark-code-on-push.test.mjs`: see the PR body for counts.

## Follow-up
(none)
<!-- SECTION:FINAL-SUMMARY:END -->
