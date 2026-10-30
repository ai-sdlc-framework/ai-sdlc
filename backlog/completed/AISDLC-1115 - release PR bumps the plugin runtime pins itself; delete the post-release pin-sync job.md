---
id: AISDLC-1115
title: >-
  release PR bumps the plugin runtime pins itself (plugin joins the linked-versions group); delete the post-release pin-sync job
status: Done
assignee: []
created_date: '2026-10-29'
labels:
  - release
  - stability
  - governance
dependencies: []
references:
  - release-please-config.json
  - .release-please-manifest.json
  - .github/workflows/release.yml
  - .github/workflows/main-health-monitor.yml
  - scripts/sync-plugin-runtime-deps.mjs
  - scripts/sync-plugin-runtime-deps.test.mjs
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - docs/operations/release-flow.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every runtime release leaves `main` red. The release PR bumps `pipeline-cli` and `orchestrator` but the plugin's `runtimeDependencies` pins in `ai-sdlc-plugin/plugin.json` and `ai-sdlc-plugin/.claude-plugin/plugin.json` stay at the previous version, because they live in a custom field of a separately versioned `simple` component that release-please's `node-workspace` plugin never rewrites. A post-release job in `release.yml` (`sync-plugin-runtime-deps`) then runs `scripts/sync-plugin-runtime-deps.mjs` and opens a `chore/sync-runtime-pins-<plugin version>` PR. Between the release landing and that PR landing, `main-health-monitor` fails on `sync:plugin-runtime-deps:check`, and on 2026-10-29 the pin-sync PR (#2135) itself needed attestation and governance handling and stayed open for hours. The operator asked why the pins are not bumped in the release PR itself.

**Five-step review (requirements first).** The requirement questioned is "the plugin keeps its own version line, independent of the runtime": the plugin pins the runtime exactly and ships with it, so a shared version number is correct and the separate line only exists because of the tooling gap AISDLC-577 recorded. Deleted: the `sync-plugin-runtime-deps` job in `release.yml`, `scripts/sync-plugin-runtime-deps.mjs`, its test, the three `sync:plugin-runtime-deps*` root scripts, the `--pr` step in the PR gate and the `--check` step in `main-health-monitor`. Simplified: `ai-sdlc-plugin` joins the `node-packages` linked-versions group, so every release PR carries one version for runtime and plugin, and two more `json` extra-files entries (`$.runtimeDependencies['@ai-sdlc/orchestrator']` and `$.runtimeDependencies['@ai-sdlc/pipeline-cli']` in both plugin.json files) write that version into the pins inside the release PR; the pins become exact versions, as the `@ai-sdlc/plugin-mcp-server` pin already is. Accelerated: no drift window, no second PR, no bot branch, `main` stays green after a release. Automated: a small test asserts that both plugin.json pin values equal the manifest's `pipeline-cli` version, so a release that misses a pin fails `pnpm test` on the release branch itself.

Fix: edit `release-please-config.json` (add `ai-sdlc-plugin` to the linked group, add the four pin extra-files entries, keep the four existing `$.version` entries), set `.release-please-manifest.json` `ai-sdlc-plugin` to the group version so the next release bumps both together (the plugin version jumps from 0.33.x to the group's next version; note it in `docs/operations/release-flow.md` and in the plugin CHANGELOG via the release, never by hand), delete the job, script, test and root scripts listed above, drop the two workflow steps, add the pin-equals-manifest test, and update `docs/operations/release-flow.md`. The plugin's own install path that reads `runtimeDependencies` must accept an exact version (verify with the existing install test). `@ai-sdlc/plugin-mcp-server` pin is out of scope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `release-please-config.json` lists `ai-sdlc-plugin` in the `node-packages` linked-versions group and has `json` extra-files entries that write the release version into `$.runtimeDependencies['@ai-sdlc/orchestrator']` and `$.runtimeDependencies['@ai-sdlc/pipeline-cli']` in both `ai-sdlc-plugin/plugin.json` and `ai-sdlc-plugin/.claude-plugin/plugin.json`.
- [ ] A dry run of release-please against the branch (release-please CLI `release-pr --dry-run`, or the existing config test if one exists) shows one release PR bumping runtime packages, the plugin version and the two pins to the same version.
- [ ] `release.yml` no longer has the `sync-plugin-runtime-deps` job; `scripts/sync-plugin-runtime-deps.mjs`, its test and the `sync:plugin-runtime-deps`, `sync:plugin-runtime-deps:check` and `sync:plugin-runtime-deps:check:pr` root scripts are gone; `ai-sdlc-gate.yml` and `main-health-monitor.yml` no longer call them.
- [ ] A test fails when either plugin.json pin for orchestrator or pipeline-cli differs from the `pipeline-cli` version in `.release-please-manifest.json`.
- [ ] The plugin install path resolves an exact `runtimeDependencies` pin (existing install test passes with the new pin form).
- [ ] `docs/operations/release-flow.md` describes the single-PR flow and the version-line merge, and no longer documents the pin-sync job.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Pre-condition: the pending pin-sync PR for 0.38.0 (#2135) either lands first or is superseded by this change; whichever lands second must not reintroduce the old range form. Decision record: DEC-0278 (link the plugin version line to the runtime group).
