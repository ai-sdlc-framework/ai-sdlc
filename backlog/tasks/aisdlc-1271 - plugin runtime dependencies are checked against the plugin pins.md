---
id: AISDLC-1271
title: 'Plugin runtime dependencies: every command checks the installed versions against the plugin pins'
status: In Progress
assignee: []
created_date: '2026-11-13'
labels:
  - plugin
  - install
  - reliability
dependencies: []
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/check-plugin-version.js
  - ai-sdlc-plugin/.claude-plugin/plugin.json
priority: high
dispatchable: true
dispatchableReason: 'Incident 2026-11-13 reported by the ai-sdlc-io planner (operator standing order 2026-11-09: file every io-planner report; operator words on this one: "we cannot have this happen again"). The monorepo planner verified the cached pipeline-cli version, the existence-only check in resolve-pipeline-cli.sh and the exact pins in plugin.json. Bounded to three scripts and their tests.'
---

## Description

**Incident.** On the ai-sdlc-io project the plugin cache directory `~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.42.0/` held `@ai-sdlc/pipeline-cli` and `@ai-sdlc/orchestrator` 0.41.0 from 2026-11-09 to 2026-11-13, although `plugin.json` pins both at exactly `0.42.0`. `/ai-sdlc:version` said "up to date" throughout. The hierarchy there ran 0.41.0 code, without the board-scoped orphan sweep of AISDLC-1252, and its tick killed every executor session of the ai-sdlc board on the shared tmux server on 2026-11-13. `bash scripts/install-runtime-deps.sh <cache>` converged the directory in four seconds once run by hand.

**Cause, as reported by the ai-sdlc-io planner.** Verified by the monorepo planner where marked.

1. The marketplace is a directory source. The cache directory is a copy of `ai-sdlc-plugin/`, `node_modules` included, taken 36 seconds before the source directory's own install reached 0.42.0. Reported, with file timestamps.
2. The session-start self-heal ran against the source directory, not the cache copy: `hooks/session-start.js` checks only `CLAUDE_PLUGIN_ROOT` (verified, line 85), and the hooks resolved to the source directory in all 54 sessions (reported). The ai-sdlc-io project also exports `CLAUDE_PLUGIN_ROOT` to the cache directory for Bash, so commands ran from the copy that was never checked.
3. The copy inherited the sentinel `node_modules/.ai-sdlc-installed` and `.stale-runtime-cache.json`, so it looked installed. Reported.
4. `_deps_complete` in `scripts/resolve-pipeline-cli.sh` tests file existence only (verified, lines 111 to 114). Its comment says a version check was removed because it cost one to three `npm view` network calls per command.
5. `hooks/check-plugin-version.js` compares the plugin version to the marketplace only; runtime dependency versions are never read. Reported.

**Shape.** The pins in `plugin.json` `runtimeDependencies` are exact versions (verified: `0.42.0`, `0.42.0`, `0.9.2`), so "does the installed version equal the pin" is a comparison of local files with no network call. `resolve-pipeline-cli.sh` runs on every command and resolves the directory that is actually used, so the check belongs there: it then covers the source directory, every cache copy and any `CLAUDE_PLUGIN_ROOT` value without enumerating them.

On a mismatch the script runs the existing self-heal (`install-runtime-deps.sh` on that directory) and, if the versions still differ afterwards, exits non-zero with a message naming the package, the installed version and the pin. It never continues on a mismatched install. When a pin is a range rather than an exact version the local check does not apply and the existing behaviour stays.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the requirement is that a command never runs a pipeline-cli other than the one the plugin pins; "installed" was standing in for it. 2. Deleted: reliance on the copied sentinel as proof of a correct install in `_deps_complete`; the report's separate asks to scan every cache directory at session start and to change the release flow are not built, because a check in the resolver covers both. 3. Simplified or optimised: one local comparison of `package.json` versions against exact pins, no network. 4. Accelerated: the check adds file reads only; the per-command latency budget in the existing comment is kept. 5. Automated: tests for the mismatch, the heal and the hard failure; `/ai-sdlc:version` and `doctor` report the same comparison.

## Acceptance Criteria

- [ ] #1 `resolve-pipeline-cli.sh` compares the installed `package.json` version of each `runtimeDependencies` entry with an exact pin to that pin, using local files only; a test asserts that no network command is spawned on this path.
- [ ] #2 On a mismatch the script runs the existing self-heal on the resolved directory and then re-checks; a test starts from a directory that holds an older version plus the `.ai-sdlc-installed` sentinel and ends with the pinned version (installer stubbed).
- [ ] #3 When the versions still differ after the heal, the script exits non-zero and prints the package name, the installed version, the pin and the directory; it prints no usable bin path.
- [ ] #4 A pin that is not an exact version skips the local comparison and keeps the present behaviour; a test covers it.
- [ ] #5 The repository's own build (Topology 0, AISDLC-716) is unaffected; the existing tests for it pass unchanged.
- [ ] #6 `/ai-sdlc:version` (`hooks/check-plugin-version.js`) and `doctor` print each runtime dependency as installed version against pin, and report "up to date" only when the plugin version and every exact pin match.
- [ ] #7 The PR body states whether the copied sentinel and `.stale-runtime-cache.json` still need a change once the first three criteria are met, with the reason; no change is made to them without one.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
