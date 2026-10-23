---
id: AISDLC-1059
title: 'release pin-sync job opens a PR instead of pushing to protected main, so a release never leaves the drift check red'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - ci
  - release
  - bug
  - velocity
dependencies: []
references:
  - .github/workflows/release.yml
  - scripts/sync-plugin-runtime-deps.mjs
  - scripts/sync-plugin-runtime-deps.test.mjs
  - docs/operations/release-flow.md
priority: high
dispatchable: true
---

## Description

After release 0.36.0 landed on 2026-10-23 (PR #1736), the `sync-plugin-runtime-deps` job of `.github/workflows/release.yml` computed the pin bump correctly and then failed at `git push origin HEAD:main` with `GH006: Protected branch update failed ... protected branch hook declined` (run 39976770750). Main branch protection has `enforce_admins` on and requires `ai-sdlc/pr-ready`, so no direct push can land, token or not. The previous two releases (2026-10-16 and earlier) went through on the same job, so the protection posture changed between those dates. The result: `ai-sdlc-plugin/plugin.json` and `ai-sdlc-plugin/.claude-plugin/plugin.json` kept `>=0.35.0` pins while both runtimes were published at 0.36.0, `pnpm sync:plugin-runtime-deps:check` (run by the gate on every PR) went red repo-wide, and the first PR after the release (#1967) failed its local suite on it. The operator landed the bump by hand as PR #1968.

In the same run, the `publish-npm` job's "Rebuild plugin cache from the published runtime" step failed with `ETARGET No matching version found for @ai-sdlc/orchestrator@>=0.36.0` although `npm view` shows 0.36.0 for both packages a few minutes later: the step queries the registry before propagation. Treat it as a second symptom of the same run and fix it in this task only if the cure is a bounded retry; otherwise note it in the PR body.

Fix: the job stops pushing to main. It commits the bump on a branch `chore/sync-runtime-pins-<version>` and opens a non-draft PR with `gh pr create` (the auto-enable workflow arms it; it lands through `ai-sdlc/pr-ready` like any other trusted PR), or it is deleted in favour of release-please's own `extra-files` pin updates if release-please can source a sibling component's version (check the `release-please-config.json` plugin options first; that deletion is the preferred outcome). Either way the drift check never depends on a push the protection refuses.

**Five-step review (requirements first).** Requirement questioned: does the repository need a bot that pushes to main at all? No; every other change lands through a PR and the gate, and a protected branch is the control that refused it. Deletion: the direct push, and the whole job if release-please can carry the pins. Simplified: one landing path for every change to main. Accelerated: the PR path is armed on creation, so the pins land minutes after the release instead of waiting for a person. Automated last: the release workflow test (`.github/workflows/__tests__/`) asserts the job never runs `git push ... main`, and a dry run of the job on a fixture repo asserts it opens a PR.

## Acceptance Criteria

- [ ] `release.yml` contains no `git push origin HEAD:main` (or any push to a protected branch) in the pin-sync job; the job opens a PR or is deleted in favour of release-please-managed pins, and `docs/operations/release-flow.md` describes the new path.
- [ ] A workflow test asserts the absence of the direct push and the presence of the PR step (or the release-please config that replaces the job).
- [ ] The `publish-npm` cache-rebuild step either retries with a bounded wait for registry propagation or its failure is documented in the PR body as a separate symptom.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
