---
id: AISDLC-1409
title: 'Adopters get the protected knowledge scope check on push'
status: To Do
assignee: []
created_date: '2026-11-24'
labels:
  - adopter
  - knowledge
  - security
dependencies:
  - AISDLC-1407
references:
  - scripts/check-knowledge-scope.sh
  - scripts/check-pr-body-protected.sh
  - pipeline-cli/src/knowledge/scope-check.ts
  - pipeline-cli/src/steps/hooks-check.ts
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
priority: medium
---

## Description

**Five-step review (requirements first).** RFC-0053 (OQ-1 resolution and the Security section) requires that a `protected` entry never enters the tracked root and never appears in a PR body. That requirement holds for every repository that uses the store, not only this one. Nothing to delete. Simplest fix: reuse `cli-context check-scope` and `check-pr-body` as they are and give adopters a caller that does not depend on this repository's layout.

**Gap.** The checks run only here: `.husky/pre-push` calls `scripts/check-knowledge-scope.sh` and `scripts/check-pr-body-protected.sh`. The script resolves `../pipeline-cli/bin/cli-context.mjs` and `../pipeline-cli/dist/cli/context.js` relative to itself and exits 0 with a "skipping" message when the build is absent outside CI. No init, setup, manifest, plugin hook or pipeline step installs or runs the check in an adopter; `hooks-check.ts` states that adopters without husky pass with no hook run. So an adopter has no guard against pushing a protected entry.

## Fix

- Run the two checks for adopters from a path the plugin controls, resolving `cli-context` the way the plugin already resolves pipeline-cli (`resolve-pipeline-cli.sh`): in the push step of `/ai-sdlc execute` (before the push and before the PR body is posted). Fail closed when the CLI cannot be resolved and the repository has a knowledge store.
- A repository with no knowledge store (no tracked root, no protected root) passes without running anything.
- `doctor`: warn when a protected root exists and no push-time check is wired.
- Keep this repository's husky hook as it is.
- Not in this task: installing git hooks into adopter repositories. If the push step is judged not enough (a plain `git push` outside the pipeline is not covered), say so in the PR body for the planner; do not add a hook installer here.

## Acceptance Criteria

- [ ] #1 Test: in a project fixture with a `protected` entry in the tracked root, the push step refuses and names the entry.
- [ ] #2 Test: a PR body that cites a protected entry is refused before posting.
- [ ] #3 Test: a project with no knowledge store passes and runs no check; a project with a store and an unresolvable CLI fails closed.
- [ ] #4 Test: `doctor` warns when a protected root exists and the check is not wired.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
