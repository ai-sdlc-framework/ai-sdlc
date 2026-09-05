---
id: AISDLC-577
title: >-
  Auto-sync plugin runtimeDependencies pins inside release-please bump (unblock
  every release PR)
status: Done
assignee: []
created_date: '2026-09-05 17:09'
labels:
  - release
  - attestation
  - aisdlc-574-followup
  - ci
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-574 added `scripts/sync-plugin-runtime-deps.mjs` + the `plugin manifests — runtimeDependencies pins must not lag the workspace` gate (in `scripts/install-runtime-deps.test.mjs`, run via `pnpm test:install-runtime-deps-gate` inside `pnpm test`). But the sync itself only runs as a JOB in `release.yml` at PUBLISH time (post-merge), NOT inside the release-please version bump. Ordering:

1. release-please opens/updates `chore: release main` PR, bumping workspace packages (e.g. 0.19.0 → 0.20.0) but LEAVING plugin `runtimeDependencies` pins at `^0.19.0`.
2. The release PR's OWN CI runs `pnpm test` → the 574 gate fails: `^0.19.0` (= `>=0.19.0 <0.20.0`, caret-on-0.x) does NOT resolve the bumped 0.20.0 package → `ai-sdlc/pr-ready` FAILS.
3. The release PR can NEVER go green on its own; a human must manually run the sync + push to the release branch before every release.

Observed 2026-09-05 on PR #1002 (release of AISDLC-575): the release PR failed `Build & Test` with:
```
not ok 1 - @ai-sdlc/orchestrator runtimeDependencies pin resolves to >= the workspace package version
not ok 2 - @ai-sdlc/pipeline-cli runtimeDependencies pin resolves to >= the workspace package version
not ok 2 - plugin manifests — runtimeDependencies pins must not lag the workspace (AISDLC-574)
```
Unblocked manually by running `sync-plugin-runtime-deps.mjs` on the release branch and pushing `^0.20.0` pins.

## Scope

Make the pin sync happen AS PART OF the release-please bump so the release PR is born green. Options to evaluate (decision-rubric candidate):
1. **release-please `extra-files` custom updater** — teach release-please to rewrite the two plugin manifests' `runtimeDependencies` pins in the same commit it bumps the versions. Cleanest; keeps everything in the bump commit.
2. **release-please `generic` updater annotations** (`x-release-please-version` markers) on the runtimeDependencies lines — may not support caret ranges cleanly.
3. **A release-please post-processing GitHub Action step** on the `release-please--branches--main` branch that runs `sync-plugin-runtime-deps.mjs` and commits back to the release PR branch BEFORE CI evaluates (ordering-sensitive; risk of race with release-please's own updates).
4. Keep the sync at publish time BUT relax the gate so it only enforces on non-release branches (weakest — hides real drift on feature PRs' release readiness).

Recommend option 1 if release-please's extra-files supports the `^X.Y.0` rewrite; else option 3.

## Acceptance Criteria
- A release-please `chore: release main` PR that bumps workspace packages ALSO updates both plugin manifests' `runtimeDependencies` pins in the same PR, with NO manual intervention.
- The 574 `install-runtime-deps-gate` passes on the release PR's first CI run.
- Hermetic/CI test proving a simulated version bump produces synced pins (extend `sync-plugin-runtime-deps.test.mjs` or a release-config test).
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Discovered unblocking PR #1002 (AISDLC-575 release). Composes with [[aisdlc-574]] (introduced the pins + gate) and [[aisdlc-558]] (single-source the two plugin manifests — would halve the surface this sync touches). Until this ships, every release PR needs the manual `sync-plugin-runtime-deps.mjs` + push-to-release-branch step.

## Resolution

Implemented option 3 (release-please's `extra-files` jsonpath rewriter has no
mechanism to source a SIBLING component's bumped version — cross-component
version injection isn't supported, so option 1/2 were not viable without a
custom updater plugin).

Added a new `sync-plugin-runtime-deps-on-pr` job in `.github/workflows/release.yml`
that runs on every push to `main` (right after `release-please`), checks
whether an open `release-please--branches--main` PR branch exists, and if so
checks out that branch, runs `scripts/sync-plugin-runtime-deps.mjs --check`,
and — only on drift — runs the sync in write mode and pushes a fixup commit
back onto the SAME release PR branch (never `main`). This lands BEFORE the
release PR's own CI evaluates the AISDLC-574 gate, so the PR is born green.
No infinite-loop risk: `release.yml`'s `push` trigger is scoped to `main`
only, so a push to the release-please branch cannot re-fire this workflow.

The original post-merge `sync-plugin-runtime-deps` job (AISDLC-574) is kept
as a defense-in-depth fallback in case the pre-merge job fails transiently.

`scripts/sync-plugin-runtime-deps.mjs` (`computeDesiredPins`/`applyPinsToManifest`)
remains the single source of the pin-computation logic — the new job only
adds a new invocation site (a different branch/ref), no duplicated math.

New workflow-structure tests in
`.github/workflows/__tests__/release-yml-pin-sync.test.mjs` (wired into
`pnpm test:release-please-config`) assert: the job exists, depends on
`release-please`, targets the release PR branch (not `main`) for both
checkout and push, is check-then-write, gates its steps on branch existence,
cannot loop (push trigger excludes the release-please branch), uses
`AI_SDLC_PAT`, and that the post-merge fallback job is retained. The
underlying pin-computation logic (a version bump producing synced pins) is
already covered end-to-end by `scripts/sync-plugin-runtime-deps.test.mjs`
(AISDLC-574).
<!-- SECTION:DESCRIPTION:END -->
