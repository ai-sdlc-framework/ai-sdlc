---
id: AISDLC-1068
title: 'plugin runtime pin drift check moves off the per-PR gate so a release pin lag never blocks every open PR'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - ci
  - release
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/main-health-monitor.yml
  - scripts/sync-plugin-runtime-deps.mjs
  - docs/operations/release-flow.md
---

## Description

RCA 2026-10-23 (0.36.0 release). The gate job of `ai-sdlc-gate.yml` runs `pnpm sync:plugin-runtime-deps:check` on every pull request. When the release's post-merge pin sync failed (its push to `main` was rejected by branch protection), the plugin pins on `main` lagged the released 0.36.0 and the check turned red on every open PR at once, including the hotfix PR that was trying to repair the pipeline (#1967 could not go green until the pins landed by hand in #1968/#1971). A check whose red state is caused by `main`, not by the PR under test, does not belong in the per-PR gate: it blocks exactly the PR that fixes it.

Fix: (1) remove `pnpm sync:plugin-runtime-deps:check` from the per-PR gate step in `ai-sdlc-gate.yml`; (2) run it in `main-health-monitor.yml` on every push to `main` and on a schedule, with the existing main-health reporting (a red there opens or updates the single main-health issue, as other main-health checks do); (3) keep it in the release workflow where the sync job already tolerates the expected lag; (4) in the per-PR gate keep only the cheap self-consistency part of the script if one exists (a PR that edits the pins must keep them consistent with each other), under a new `--pr` flag, and document the split in `docs/operations/release-flow.md`. Update `docs/operations/quality-gate.md` and `docs/operations/pre-push-and-ci-reference.md` where the check is listed.

**Five-step review (requirements first).** Requirement questioned: does every PR need to prove the pins match the registry? No: only `main` after a release does; a PR proves it did not break the pins it touched. Deletion: the registry comparison from the per-PR gate. Simplified: main-state checks on `main`, PR-state checks on PRs. Accelerated: a release pin lag no longer stalls the drain. Automated last: the main-health monitor owns the alert.

## Acceptance Criteria

- [ ] `ai-sdlc-gate.yml` no longer runs the registry comparison on pull requests; a PR opened while `main` pins lag the registry passes `ai-sdlc/pr-ready` (document the verification in the PR body with the run link).
- [ ] `main-health-monitor.yml` runs `sync:plugin-runtime-deps:check` on push to `main` and on its schedule and reports a red through the existing main-health path; `docs/operations/release-flow.md`, `quality-gate.md` and `pre-push-and-ci-reference.md` updated.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
