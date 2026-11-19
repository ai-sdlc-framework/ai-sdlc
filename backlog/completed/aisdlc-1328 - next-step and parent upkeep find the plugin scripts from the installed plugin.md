---
id: AISDLC-1328
title: 'next-step and parent upkeep find the plugin scripts from the installed plugin'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - plugin
  - adopter
dependencies: []
references:
  - pipeline-cli/src/cli/next-step.ts
  - pipeline-cli/src/cli/next-step.test.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/next-step/review-finalize.ts
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
priority: high
dispatchable: true
dispatchableReason: 'Bounded to one resolver function, its two callers and its tests.'
---

## Description

**Gap.** `ai-sdlc-pipeline next-step` and the parent upkeep of `cli-hierarchy` look for the plugin scripts in `<working directory>/ai-sdlc-plugin/scripts` when `CLAUDE_PLUGIN_DIR` and `CLAUDE_PLUGIN_ROOT` are both unset. That folder exists only in this monorepo. A session started by the hierarchy has neither variable in its shell, so in an adopter project a run does the developer and review work and then stops at the step that saves the reviewer artifacts.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19): a task stopped with "persist-reviewer-artifacts.sh not found under `<project>/ai-sdlc-plugin/scripts`" after the developer commit and two approving reviews. Nothing was pushed, and a retry repeats the developer and review steps.

**Cause (read from the source).**

- `pipeline-cli/src/cli/next-step.ts:32-37`: `resolvePluginScriptsDir(env, cwd)` returns `env.CLAUDE_PLUGIN_DIR || env.CLAUDE_PLUGIN_ROOT || join(cwd, 'ai-sdlc-plugin')` plus `scripts`. No candidate is tested for existence, and the function has no fallback from its own location.
- Two callers: `next-step.ts:62` (the run context, read by the reviewer-artifact step in `next-step/review-finalize.ts`, the staged round, the session step and init) and `pipeline-cli/src/cli/hierarchy.ts:1481` (parent upkeep, which runs `check-orchestrator-state.sh` only when it exists, so there the wrong path skips the check without a word).
- `defaultCliBinDir()` in the same file (`next-step.ts:27-29`) already resolves from the module's own location. In an installed plugin the module sits at `<plugin>/node_modules/@ai-sdlc/pipeline-cli/dist/cli`, so the plugin folder can be found the same way.
- `pipeline-cli/src/cli/next-step.test.ts:21` asserts the working-directory fallback as the expected result.
- The command preambles and `resolve-pipeline-cli.sh` are separate text with the same defect; AISDLC-1326 and AISDLC-1327 cover them and do not touch this function.

**Shape.** The function returns the first candidate whose `scripts` folder holds `resolve-pipeline-cli.sh`, in this order: `CLAUDE_PLUGIN_DIR`, `CLAUDE_PLUGIN_ROOT`, the plugin folder found from the module's own location, `<working directory>/ai-sdlc-plugin` (the monorepo and its worktrees). When none qualifies the caller stops with one line that names the two variables and every path tried.

**Control.** No control changes. A run that cannot find the plugin scripts stops before the developer step instead of after the reviews.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "fall back to the working directory" was written for development inside this monorepo; no decision asks for it in an adopter project. Exporting a plugin variable from the session launcher was considered and is not needed once the function can locate itself. 2. Deleted: the unconditional working-directory fallback; the idea of a new session variable. 3. Simplified or optimised: one ordered list of candidates, each tested for the same marker file. 4. Accelerated: a failed resolution stops at the start of the run, before any developer or reviewer time is spent. 5. Automated: tests cover each candidate and the refusal.

- **Resolver.** `resolvePluginScriptsDir` implements the order above. The own-location candidate is computed from `import.meta.url` like `defaultCliBinDir()`; the test seam passes the module location in, so the test does not depend on where the suite runs.
- **Early stop in next-step.** When no candidate qualifies, `next-step` exits non-zero before the first step with the line described above.
- **Parent upkeep.** When no candidate qualifies, `cli-hierarchy` reports the same line as a warning and continues as today (the check is skipped); it does not start refusing ticks.
- **Tests.** Replace the assertion at `next-step.test.ts:21` and add the cases in the criteria.

Out of scope: the command preambles (AISDLC-1326); `resolve-pipeline-cli.sh` and the doctor resolver (AISDLC-1327); the variables exported by the session launcher; resuming a stopped run from its saved reviews.

## Acceptance Criteria

- [ ] #1 A test: with both variables unset and a module location inside a temporary folder laid out as `<plugin>/node_modules/@ai-sdlc/pipeline-cli/dist/cli` with `<plugin>/scripts/resolve-pipeline-cli.sh` present, the function returns `<plugin>/scripts`, whatever the working directory is.
- [ ] #2 A test: `CLAUDE_PLUGIN_DIR` set to a folder that holds the marker file wins over `CLAUDE_PLUGIN_ROOT`, the own-location candidate and the working directory.
- [ ] #3 A test: a variable set to a folder without the marker file is skipped and the next candidate is used.
- [ ] #4 A test: with both variables unset, no own-location match and a working directory that holds `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh`, the function returns that folder (the monorepo case is unchanged).
- [ ] #5 A test: with no qualifying candidate, `next-step` exits non-zero before any step runs, and the output names `CLAUDE_PLUGIN_DIR`, `CLAUDE_PLUGIN_ROOT` and each path tried.
- [ ] #6 A test: with no qualifying candidate, the parent upkeep call in `cli-hierarchy` emits the warning line once and the tick continues.
- [ ] #7 No source file under `pipeline-cli/src` other than the resolver builds a path that ends in `ai-sdlc-plugin/scripts` (a test or a grep in the suite asserts it).
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
