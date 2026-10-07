---
id: AISDLC-751
title: >-
  /ai-sdlc hierarchy plugin command wraps cli-hierarchy so the session hierarchy is driven from Claude Code
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - rfc-0051
  - dispatch
  - plugin
dependencies: []
references:
  - ai-sdlc-plugin/commands/doctor.md
  - ai-sdlc-plugin/commands/version.md
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs
  - pipeline-cli/bin/cli-hierarchy.mjs
  - pipeline-cli/src/hierarchy/
  - docs/operations/parallel-dispatch.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-06 the operator asked for `cli-hierarchy` to be reachable from the Claude plugin. Today it is only reachable as a pipeline-cli binary run from a shell in the repository, and nothing in `ai-sdlc-plugin/commands/` exposes it, although the plugin already bundles pipeline-cli (its `bin` map includes `cli-hierarchy`) and `scripts/resolve-pipeline-cli.sh` already locates that bin directory for `/ai-sdlc doctor`, `/ai-sdlc execute` and the loop commands.

Add `ai-sdlc-plugin/commands/hierarchy.md` so that `/ai-sdlc hierarchy <subcommand> [options]` runs `cli-hierarchy <subcommand> [options]` from the resolved bin, following the resolution and error shape of `doctor.md` (resolve via `resolve-pipeline-cli.sh`, print the one-line install hint when no bin is found, pass `$ARGUMENTS` through unchanged, run from the repository root with `check-repo` semantics so an adopter repo without a hierarchy gets a clear message instead of a stack trace).

Scope rules for the wrapper:
- Pass-through subcommands: `up`, `status`, `attach`, `terminals`, `brief`, `down`. `attach` and `up --attach` cannot switch the caller's terminal from inside a Claude Code session; print the exact shell command to run instead.
- `down` with no `--role` stops every session and returns inflight manifests to the queue; the command body asks the operator to confirm once before running it.
- Refuse `clear`, `tick`, `route-decision`, `check-sender` and `check-repo` with a one-line explanation: they belong to the dispatch and executor loop bodies, and `clear` already carries a caller guard in the CLI.
- With no arguments, print `cli-hierarchy --help` followed by a short "common recipes" block (start one slot: `up --executors 1 --no-planner`; watch: `status`; restart after a plugin upgrade: `down` then `up`).
- Node version: use the same Node the other plugin commands use; do not add an nvm dependency.

Update `docs/operations/parallel-dispatch.md` (and the cli-hierarchy reference page if it has landed by then) so the plugin form is the documented entry point and the bare binary is the fallback. Add a test next to the other command tests in `ai-sdlc-plugin/commands/` covering: argument pass-through, the refused subcommand list, the no-argument help path, and the missing-bin message. Register the command wherever the plugin enumerates commands if that is not automatic (check `ai-sdlc-plugin/.claude-plugin/plugin.json` and the command index test).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `/ai-sdlc hierarchy status` and `/ai-sdlc hierarchy up --executors 1 --no-planner` run the bundled `cli-hierarchy` from an installed plugin (not only in the dogfood repo) and print its output unchanged.
- [ ] `clear`, `tick`, `route-decision`, `check-sender` and `check-repo` are refused with the one-line explanation; `down` without `--role` asks for confirmation first; `attach` prints the shell command to run.
- [ ] No arguments prints the CLI help plus the common-recipes block; a repo without pipeline-cli prints the install hint used by `/ai-sdlc doctor`.
- [ ] Command test covers pass-through, refusals, help path and missing bin; docs name the plugin form as the entry point.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass apart from the 14 pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), disclosed in the PR body.
