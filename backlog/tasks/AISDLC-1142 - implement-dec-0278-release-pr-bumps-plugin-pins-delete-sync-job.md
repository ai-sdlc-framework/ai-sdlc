---
id: AISDLC-1142
title: 'Implement DEC-0278: the release PR bumps the plugin runtime pins itself; delete the post-release pin-sync job and the main-health pin check (AISDLC-1115 was closed without the work)'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - release
  - plugin
  - ci
dependencies: []
references:
  - release-please-config.json
  - .github/workflows/release.yml
  - .github/workflows/main-health-monitor.yml
  - scripts/sync-plugin-runtime-deps.mjs
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - docs/operations/release-flow.md
priority: high
dispatchable: true
---

## Description

DEC-0278 (2026-10-29, operator answer `link-versions`) decided that one release PR bumps the runtime packages, the plugin version and the two `runtimeDependencies` pins together, and that the post-release `sync-plugin-runtime-deps` job is deleted. Its task AISDLC-1115 is marked Done, but the work never landed: commit 10a925bb (#2166) completed it citing #2145 and #2147, which were the filing PRs for the task and the decision. On main today `release.yml` still runs the job (line 75), `main-health-monitor.yml` still fails the run on `pnpm sync:plugin-runtime-deps:check` (line 107, `plugin-pins` outcome), and the `node-packages` linked-versions group in `release-please-config.json` still leaves out `ai-sdlc-plugin`. Result on 2026-10-31: release 0.39.0 landed, pins stayed at `>=0.38.0 <1.0.0`, main went RED on `plugin-pins`, and the bot PR #2209 stalled on attestation and governance gates. Of the four sync PRs ever opened, one merged.

Nothing at runtime refuses an installed runtime below the pin (the signer's floor is the hardcoded `MIN_RUNTIME_VERSIONS` in `ai-sdlc-plugin/scripts/sign-attestation.mjs`), so the recurring red main is release hygiene, not an adopter break; it still blocks the main-health signal for every landing.

**Five-step review (requirements first).**
1. Requirement questioned: must the pins follow every runtime release? DEC-0278 says yes, in the same release PR, so the plugin and its runtime share one version line and no drift window exists. This task implements that ruling; it does not reopen it.
2. Delete: the `sync-plugin-runtime-deps` job in `release.yml` (and its working-tree run in `publish-npm`), the `Plugin runtime pin drift check` step and the `plugin-pins` outcome in `main-health-monitor.yml`, `scripts/sync-plugin-runtime-deps.mjs` with its test and the three `sync:plugin-runtime-deps*` scripts in `package.json`.
3. Simplify: add `ai-sdlc-plugin` to the `node-packages` linked-versions group and `json` extra-files entries that write the release version into `$.runtimeDependencies['@ai-sdlc/orchestrator']` and `['@ai-sdlc/pipeline-cli']` of both plugin manifests; the pin form becomes an exact version. Keep the per-PR `--pr` agreement check only if it survives as a plain test (both manifests equal and equal to the manifest version).
4. Accelerate: one fewer post-release job; no bot PR to re-sign.
5. Automate: a test fails when either plugin manifest pin differs from the `pipeline-cli` version in `.release-please-manifest.json`; `docs/operations/release-flow.md` documents the single-PR flow.

Velocity impact: main stops going red after every release; no post-release PR to attest, review or re-sign.

## Acceptance Criteria

- [ ] AC-1: `release-please-config.json` lists `ai-sdlc-plugin` in the `node-packages` linked-versions group, with `json` extra-files entries for both runtime pins in `ai-sdlc-plugin/plugin.json` and `ai-sdlc-plugin/.claude-plugin/plugin.json`; a release-please dry run (`release-pr --dry-run` or the existing config test) shows one release PR bumping the runtime packages, the plugin version and both pins.
- [ ] AC-2: `release.yml` has no `sync-plugin-runtime-deps` job and `publish-npm` no longer runs the script; `main-health-monitor.yml` has no `Plugin runtime pin drift check` step and no `plugin-pins` outcome; `scripts/sync-plugin-runtime-deps.mjs`, its test and the `sync:plugin-runtime-deps*` scripts are deleted; no non-test importer or doc still references them (`pnpm dark-code:check` and `backlog-drift` green).
- [ ] AC-3: A test fails when either plugin manifest pin for orchestrator or pipeline-cli differs from the `pipeline-cli` version in `.release-please-manifest.json`; the plugin install path (`install-runtime-deps.sh` tests) resolves the exact pin form.
- [ ] AC-4: `docs/operations/release-flow.md` describes the single-PR flow and no longer documents the pin-sync job; the AISDLC-1115 completed task file gets a one-line note that its work landed through AISDLC-1142.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; the task file records the test command and its summary line.

## Notes

Pre-condition: #2209 (pins to 0.39.0, stopgap that clears main today) lands first or is superseded by this PR; whichever lands second must not reintroduce the range form. The first release after this lands moves the plugin from 0.34.0 onto the shared 0.39.x line; `docs/operations/release-flow.md` names that version-line merge. Decision record: DEC-0278. Origin: dispatch recommendation 2026-10-31 and planner research showing AISDLC-1115 closed without the work (process defect: bulk completion by #2166 on filing PRs, worth a separate check in `check-task-moved.sh` later, not in scope here).
