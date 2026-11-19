---
id: AISDLC-1326
title: 'Command preambles never fall back to a plugin folder that does not exist'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - plugin
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/execute.test.mjs
  - ai-sdlc-plugin/commands/init.md
  - ai-sdlc-plugin/commands/doctor.md
  - ai-sdlc-plugin/commands/hierarchy.md
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/commands/cleanup.md
  - ai-sdlc-plugin/commands/memory-dream.md
  - ai-sdlc-plugin/commands/import-spec.md
  - ai-sdlc-plugin/commands/rfc-init.md
  - ai-sdlc-plugin/commands/no-bare-paths.test.mjs
  - ai-sdlc-plugin/README.md
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to the path preamble of ten command files, one README section and their tests.'
---

## Description

**Gap.** Ten plugin commands find the plugin scripts with a preamble that ends in `$(pwd)/ai-sdlc-plugin`. That folder exists only in this monorepo. In an adopter project, when `CLAUDE_PLUGIN_DIR` and `CLAUDE_PLUGIN_ROOT` are both unset, the preamble yields a path that does not exist and the command fails later with a file-not-found error that does not name the cause.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): an execute run aborted because the plugin root resolved to `<project>/ai-sdlc-plugin`, and only a fresh run resumed it.

**Cause (read from the source).**

- 14 lines in 12 files carry the fallback; 10 of them are command files. Three textual variants exist:
  - one line: `PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}}/scripts"` (`ai-sdlc-plugin/commands/execute.md:61`, also in `memory-dream.md`, `import-spec.md`, `executor.md`, `rfc-init.md`, `cleanup.md`);
  - if / elif / else (`hierarchy.md:51-56`, `planner.md:69-74`);
  - `CLAUDE_PLUGIN_ROOT` only, never `CLAUDE_PLUGIN_DIR` (`init.md:29-30`, `doctor.md:69-70`).
- Direct uses outside the preamble: `execute.md:37` and `doctor.md:87` call `"${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}/..."`.
- The text is copied per command; `ai-sdlc-plugin/README.md` near line 197 tells authors to copy it. Nothing generates it.
- `ai-sdlc-plugin/commands/execute.test.mjs:380-383` asserts the exact fallback string.

**Shape.** One preamble, identical in every command that needs the plugin scripts. It resolves in this order and stops at the first that exists on disk: `CLAUDE_PLUGIN_DIR`, `CLAUDE_PLUGIN_ROOT`, `./ai-sdlc-plugin` (the monorepo), the install entry of the current project in `~/.claude/plugins/installed_plugins.json`. When none exists it prints one line that names the two variables and the registry file and exits non-zero before any other step runs.

**Install entry rule.** In the registry, the plugin key starts with `ai-sdlc@`. Among its entries, take the `project` or `local` entry whose `projectPath` is the working directory or its nearest ancestor; when there is none, take the `user` entry. Use its `installPath` only when that folder exists.

**Control.** No control changes. A command that cannot find the plugin now stops with a reason instead of running on with a wrong path.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "fall back to the working directory" was written for development inside this monorepo; no decision asks for it in an adopter project, where it can never be right. 2. Deleted: the unconditional working-directory fallback and two of the three preamble variants. 3. Simplified or optimised: one preamble text, each candidate tested for existence. 4. Accelerated: a failed resolution stops in the first second with the cause, instead of aborting a run part-way. 5. Automated: one test asserts that every command carries the same preamble, so a new command cannot bring back a variant.

- **One preamble.** Replace the three variants in the ten command files with one block that implements the order above and sets `PLUGIN_SCRIPTS_DIR`. The direct uses in `execute.md:37` and `doctor.md:87` use the resolved root.
- **Refusal.** The failure line names `CLAUDE_PLUGIN_DIR`, `CLAUDE_PLUGIN_ROOT` and the registry file, and the block exits non-zero.
- **README.** The section that tells authors to copy the preamble shows the new block and the order.
- **Tests.** Update `execute.test.mjs` to the new block; extend `no-bare-paths.test.mjs` (or add a test beside it) with the checks in the criteria.

Out of scope: `setup.md` and `version.md`, which use the bare variable; `resolve-pipeline-cli.sh` and the doctor resolver (AISDLC-1327); the pre-push hook (AISDLC-1325); generating the preamble from a shared source.

## Acceptance Criteria

- [ ] #1 A test extracts the preamble from every file under `ai-sdlc-plugin/commands/` that sets `PLUGIN_SCRIPTS_DIR` and fails when two files differ.
- [ ] #2 A test asserts that no file under `ai-sdlc-plugin/commands/` uses `$(pwd)/ai-sdlc-plugin` without a test that the folder exists.
- [ ] #3 A test runs the preamble in a temporary directory with both variables unset, no `ai-sdlc-plugin` folder and a `HOME` whose registry has no matching entry: exit code is non-zero and the output names both variables and the registry file.
- [ ] #4 A test runs it with a registry that holds a `project` entry for an ancestor of the working directory and a `user` entry: the `project` entry's `installPath` wins. With only the `user` entry, that one is used. An entry whose `installPath` does not exist is skipped.
- [ ] #5 A test runs it inside a directory that holds `ai-sdlc-plugin/scripts` with both variables unset: it resolves to that folder (the monorepo case is unchanged).
- [ ] #6 A test: when `CLAUDE_PLUGIN_DIR` is set to an existing folder it wins over every other source, in every command, including `init.md` and `doctor.md`.
- [ ] #7 `ai-sdlc-plugin/README.md` shows the new preamble and its order.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
