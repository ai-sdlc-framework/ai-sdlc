---
id: AISDLC-1367
title: 'Plugin commands and agents read the plugin root through text Claude Code substitutes'
status: To Do
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - plugin
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/execute.test.mjs
  - ai-sdlc-plugin/commands/plugin-root-preamble.test.mjs
  - ai-sdlc-plugin/commands/init.md
  - ai-sdlc-plugin/commands/doctor.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/correctness-reviewer.md
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/README.md
  - pipeline-cli/src/cli/next-step.ts
priority: medium
---

## Description

**Gap.** Command and agent text reads the plugin root as `${CLAUDE_PLUGIN_ROOT:-}`. Per the issue, Claude Code does not substitute that form and does not set the variable in the Bash tool. With a `--plugin-dir` load, no exported variable and a repository other than ai-sdlc, the preamble finds nothing from the variable and nothing in the registry file, so `/ai-sdlc:execute` stops at its first block.

Reference: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2741

**Already fixed on main (not part of this task).**

- Wrong path into the adopter repo: AISDLC-1326 (57c92d4a2) replaced the `$(pwd)/ai-sdlc-plugin` fallback with an existence-tested preamble that also reads `~/.claude/plugins/installed_plugins.json`. It now fails loudly instead of running a missing file.
- `next-step` and `hierarchy` finding the plugin scripts: AISDLC-1328 (d52c91b2d) added the module-location candidate (`pipeline-cli/src/cli/next-step.ts:36-46`), used by both (`next-step.ts:101`, `hierarchy.ts:1533`). `persist-reviewer-artifacts.sh` is read from that directory (`pipeline-cli/src/next-step/review-finalize.ts:374`).

**Facts read in code** (main at 687e0d596).

- The ten preambles in `ai-sdlc-plugin/commands/*.md` (for example `execute.md:39` and `:70`) still list `"${CLAUDE_PLUGIN_DIR:-}" "${CLAUDE_PLUGIN_ROOT:-}"`. `plugin-root-preamble.test.mjs:81-88` requires the block to be identical and to name both variables.
- A `--plugin-dir` load has no entry in `installed_plugins.json`, so the registry lookup in the preamble yields nothing. With the variables unset the preamble exits non-zero with `ERROR: plugin not found`.
- `doctor.md:36-41`, `setup.md:25-30` and `version.md:58` already use the plain `${CLAUDE_PLUGIN_ROOT}` form, which the issue's probe shows is substituted.
- Five reviewer agents guard on the unsubstituted form, for example `agents/code-reviewer.md:57` `[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && CANDIDATES+=(...)`. The last candidate is the relative `scripts/resolve-transcript-task-id.sh`, which exists only in the ai-sdlc repo.
- `ai-sdlc-plugin/README.md:164` says Claude Code "injects `CLAUDE_PLUGIN_ROOT` at session start and it is always available". The issue cites Claude Code's plugin manifest reference saying the variables are not in the Bash tool environment. `scripts/resolve-pipeline-cli.sh:27` and `:57` carry the same assumption.

**Observed (from the issue, not reproduced here).** A probe plugin run with `claude --plugin-dir` on Claude Code 2.1.325 and 2.1.326 returned `A=${CLAUDE_PLUGIN_ROOT}` substituted, while `${CLAUDE_PLUGIN_ROOT:-fallback}` and `$CLAUDE_PLUGIN_ROOT` came back as written, and `env | grep -c "^CLAUDE_PLUGIN"` printed 0. Not tested by the reporter: a marketplace install, and agent files.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the requirement is that a command finds the plugin with no exported variable; the `:-` form was only ever a means. 2. Deleted: the `${CLAUDE_PLUGIN_ROOT:-}` and `$CLAUDE_PLUGIN_ROOT` text forms in command and agent bodies, and the README claim that the variable is always in the Bash environment. 3. Simplified: write the plain `${CLAUDE_PLUGIN_ROOT}` where Claude Code fills it in, as one extra candidate in the existing preamble list; the registry and monorepo candidates stay as they are. Each Bash block runs alone, so each block carries the substituted path itself. 4. Accelerated: none needed. 5. Automated: a test fails on the unsubstituted forms; the preamble test runs the block with the plain form replaced by a path.

- In each command preamble, replace `"${CLAUDE_PLUGIN_ROOT:-}"` with `"${CLAUDE_PLUGIN_ROOT}"` (substituted text). If Claude Code leaves it empty or unreplaced, the existence test skips it.
- In the five reviewer agents, use the plain form in the candidate list with the existence test, not a `[ -n ... ]` guard on the unsubstituted form. Whether agent bodies are substituted is not tested by the reporter; the developer checks it (see open questions).
- Correct `README.md:164` and the comments in `resolve-pipeline-cli.sh:27,57`.
- Update `execute.test.mjs:380` and `plugin-root-preamble.test.mjs` to the new block.

Expected files (within 15): ten command files, five reviewer agent files, `execute.test.mjs`, `plugin-root-preamble.test.mjs`, `README.md`, `resolve-pipeline-cli.sh`. If the count passes 15, split the agents into a second task.

Out of scope: marketplace install behaviour, the CLI-side lookup (done in AISDLC-1328), and any change to `CLAUDE_PLUGIN_DIR`.

## Open questions

**Are agent bodies substituted like command bodies?** Claude Code docs say `${...}` resolves in skill, command and agent Markdown; the reporter did not test agent files. Interim value: assume yes and add a test with a fake path; if a probe shows no substitution, keep the registry candidate only. Recommendation: probe once with a throwaway agent before merging.

## Acceptance Criteria

- [ ] #1 A test runs the preamble with `CLAUDE_PLUGIN_DIR` and `CLAUDE_PLUGIN_ROOT` unset in the environment, the plain `${CLAUDE_PLUGIN_ROOT}` text replaced by an existing plugin path, a cwd that is not the ai-sdlc repo and no registry entry, and it resolves `PLUGIN_SCRIPTS_DIR` to that path.
- [ ] #2 The same test passes for all ten commands that set `PLUGIN_SCRIPTS_DIR`, and the block stays identical in each (`plugin-root-preamble.test.mjs`).
- [ ] #3 A test fails if any command or agent body contains `${CLAUDE_PLUGIN_ROOT:` or `$CLAUDE_PLUGIN_ROOT` outside the plain `${CLAUDE_PLUGIN_ROOT}` form.
- [ ] #4 The five reviewer agents resolve `resolve-transcript-task-id.sh` through a candidate that is checked with a file test, and a test covers an adopter cwd with the variable text substituted.
- [ ] #5 `README.md` no longer says the variable is always in the Bash environment, and a test or grep shows the claim gone from `resolve-pipeline-cli.sh` comments.
- [ ] #6 The existing no-resolution case still exits non-zero naming both variables and the registry file.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
