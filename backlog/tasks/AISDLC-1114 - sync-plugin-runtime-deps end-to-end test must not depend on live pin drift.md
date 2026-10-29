---
id: AISDLC-1114
title: >-
  sync-plugin-runtime-deps end-to-end test must not depend on live pin drift (every PR red after release 0.38.0 until the pin-sync PR lands)
status: In Progress
assignee: []
created_date: '2026-10-29'
labels:
  - release
  - tests
  - stability
dependencies: []
references:
  - scripts/sync-plugin-runtime-deps.test.mjs
  - scripts/sync-plugin-runtime-deps.mjs
  - docs/operations/release-flow.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After release #2031 (pipeline-cli 0.38.0, plugin 0.33.0) the plugin runtime pins on main lagged the workspace until the bot's pin-sync PR (#2135) lands. During that window the `CLI end-to-end` case in `scripts/sync-plugin-runtime-deps.test.mjs` runs the sync script with `--check` against the real repository and requires exit 0, so `test:gates` inside `pnpm test` fails on every PR (#1989, #1852 and the whole draft backlog on 2026-10-29). That contradicts the earlier release-flow decision that the per-PR gate runs only the `--pr` mode so a pending pin sync never turns unrelated PRs red: the workflow honours it, this test does not.

**Five-step review (requirements first).** The requirement questioned is "the end-to-end test proves the script works against this repository's live pins": a unit test must prove the script's logic, not the repository's current release state, which the release workflow already checks in `--pr` mode. Deleted: the live-repo `--check` assertion. Simplified: the end-to-end case runs against a fixture tree (a temp copy of the two plugin.json files and a fake workspace version) in both the in-sync and drifted states, asserting exit 0 and exit 1 respectively. Accelerated: no dependence on the checkout, so the test is stable in worktrees and after a release. Automated: a guard in the same test file fails if any case shells out to the script without an explicit fixture `--root`, so the live-repo dependency cannot creep back.

Fix: add a `--root <dir>` option to the script if it lacks one, rewrite the end-to-end case on fixtures covering in-sync and drifted, keep the `--pr` mode test, and add the no-live-root guard.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `pnpm test:gates` passes on a checkout whose plugin pins deliberately lag the workspace version (reproduce by editing the pin in a temp copy or by checking out the commit before #2135 lands).
- [ ] The end-to-end test covers in-sync (exit 0) and drifted (exit 1, names the drifted pin) on fixture files, never the repository's own plugin.json.
- [ ] A test fails if any case in the file runs the script without an explicit fixture root.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: dispatch report 2026-10-29 17:35Z; `Build & Test` red on #1989 and #1852 with the sync-plugin-runtime-deps `CLI end-to-end` assertion while `--pr` passes on main.

## Verification

`node --test scripts/sync-plugin-runtime-deps.test.mjs` -> `# tests 26 / # pass 26 / # fail 0`. Full `pnpm test`: only `pipeline-cli/src/hierarchy/executor-start.test.ts` failed locally because the executor session exports `AI_SDLC_EXECUTOR_TASK`; it passes (23/23) with that env cleared and this diff does not touch it.
