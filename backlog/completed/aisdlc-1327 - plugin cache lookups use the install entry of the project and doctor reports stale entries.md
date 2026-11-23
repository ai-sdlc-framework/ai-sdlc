---
id: AISDLC-1327
title: 'Plugin cache lookups use the install entry of the project, and doctor reports stale install entries'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - plugin
  - doctor
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - ai-sdlc-plugin/README.md
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one shell resolver, one doctor resolver, one new read-only doctor check and their tests.'
---

## Description

**Gap.** When the plugin variables are unset, two resolvers walk the Claude Code plugin cache and take the highest version folder they find. Which version a project runs is recorded per project in `~/.claude/plugins/installed_plugins.json`, and no code in this repository reads that file. A lookup can therefore use a version the project does not run, and nothing reports install entries that still pin an old version.

What was seen on the operator's machine on 2026-11-18: the registry held entries for 0.7.0, 0.8.1 and 0.33.0 beside the current 0.42.0, each pinned by a project that was never updated. Old folders stay on disk because of those entries, and the operator deleted cache folders by hand after updates to keep lookups from reaching them.

**Cause (read from the source).**

- `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh:343-374` (Topology 4) walks the cache and keeps the highest version (`sort -rV | head -1`, `:361`).
- `findMarketplaceInstall` (`orchestrator/src/cli/commands/doctor-checks.ts:275-294`) takes the semver-highest cache folder with `compareSemver` (`:227-240`); `resolvePluginInstall` (`:323-353`) uses it after the variables.
- No doctor check lists install entries or compares their versions; `plugin-install-ambiguity` (`:737-770`) compares only `<project>/ai-sdlc-plugin` with the highest cached version.

**Shape.** The install entry of the current project is the answer to "which plugin version does this project run". Both resolvers ask it before they walk the cache; the walk stays as the last resort and says so. Doctor reports entries pinned below the newest cached version.

**Install entry rule.** In the registry, the plugin key starts with `ai-sdlc@`. Among its entries, take the `project` or `local` entry whose `projectPath` is the project directory or its nearest ancestor; when there is none, take the `user` entry. Use its `installPath` only when that folder exists.

**Control.** No control changes. The new doctor check is read-only and has no fix: it never deletes a cache folder and never edits the registry.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "use the highest cached version" (plugin README, AISDLC-557) was a guess made without the registry; the registry states the version per project, so the guess is not needed when an entry exists. 2. Deleted: the manual step of deleting cache folders after an update; the highest-version walk is kept only for a machine with no registry entry. 3. Simplified or optimised: one stated rule for the entry, used by both resolvers. 4. Accelerated: a version mismatch is reported by doctor at once instead of being found through a failed run. 5. Automated: the doctor check runs with every `doctor`.

- **Shell resolver.** In `resolve-pipeline-cli.sh`, before the Topology 4 walk, look up the install entry by the rule above and use its `installPath` when the pipeline CLI is found under it. Keep the walk as the fallback and print on stderr that the highest cached version was used because no install entry matched.
- **Doctor resolver.** `resolvePluginInstall` asks the install entry after the variables and before `findMarketplaceInstall`. The result records which source answered.
- **New check `plugin-install-entries`.** Reads the registry and the cache. It warns, one line per entry, for each `ai-sdlc` entry whose version is lower than the newest cached version, naming the entry's project path and version and the command to update it. It fails when the entry that matches the current project points at a folder that does not exist. It passes when the registry is absent.
- **README.** The plugin README section that says "use highest version" states the new order.

Out of scope: deleting cache folders or editing the registry from any command; `vscode-hierarchy/src/roster.ts` and `scripts/first-run-smoke.mjs`, which also walk the cache; the command preambles (AISDLC-1326); the pre-push hook (AISDLC-1325).

## Acceptance Criteria

- [ ] #1 A test in `resolve-pipeline-cli.test.mjs`: with both variables unset, a cache that holds two versions and a registry whose entry for the project names the lower one, the resolver returns the lower one.
- [ ] #2 A test: same cache, registry without a matching entry or without the file: the resolver returns the highest version and stderr says that no install entry matched.
- [ ] #3 A test: an entry whose `installPath` does not exist is skipped and the walk decides.
- [ ] #4 A test in `doctor-checks.test.ts`: `resolvePluginInstall` returns the matching `project` entry over the `user` entry, the `user` entry when no `project` entry matches, and the nearest ancestor when two `project` entries match.
- [ ] #5 A test: `plugin-install-entries` warns for an entry below the newest cached version and names its project path and version; fails when the current project's entry points at a missing folder; passes with no registry file; passes when every entry is at the newest version.
- [ ] #6 A test asserts that the new check writes nothing: no cache folder is removed and the registry file is byte-identical after the check and after `doctor --fix`.
- [ ] #7 The check is registered in the doctor registry and listed in the doctor command output with the others.
- [ ] #8 `ai-sdlc-plugin/README.md` states the resolution order.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
