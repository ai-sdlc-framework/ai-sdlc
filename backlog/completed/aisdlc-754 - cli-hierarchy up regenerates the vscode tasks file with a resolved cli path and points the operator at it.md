---
id: AISDLC-754
title: >-
  cli-hierarchy up regenerates the VS Code tasks file with a resolved CLI path and points the operator at it
status: Done
assignee: []
created_date: '2026-10-07'
labels:
  - rfc-0051
  - dispatch
  - pipeline-cli
  - developer-experience
dependencies: []
references:
  - pipeline-cli/src/hierarchy/terminals.ts
  - pipeline-cli/src/hierarchy/terminals.test.ts
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/docs-parity.test.ts
  - ai-sdlc-plugin/scripts/hierarchy-dispatch.mjs
  - ai-sdlc-plugin/commands/hierarchy.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-07 the operator ran `cli-hierarchy terminals --vscode`, then the generated "hierarchy: open all agents" task, and every terminal failed. Two defects stacked:

1. `buildVscodeTasks()` in `pipeline-cli/src/hierarchy/terminals.ts` emits `command: "cli-hierarchy attach <name>"`. The bin is a workspace package in this repo and a plugin-cache dependency for adopters; it is on `PATH` in neither case, so the task fails with "command not found" wherever the CLI was not installed globally.
2. The tasks file is written once, by hand, from the roster at that moment. `cli-hierarchy up --executors 5` later added four executors and the file knew nothing about them; an operator who keeps VS Code open on the parent folder also had a stale hand-written file there that targeted the pre-RFC-0051 shared `ai-sdlc-hierarchy` tmux session and printed "agent is not running".

Make the tasks file something `up` keeps correct, and make its commands run anywhere:

- `buildVscodeTasks()` takes the absolute path of the `cli-hierarchy.mjs` bin and emits `command: "node"` with `args: ["<abs path>", "attach", "<name>"]` (array form so the path survives spaces such as `Visual Studio Code.app`-style parents and the plugin cache path). `hierarchyTerminals()` resolves that path from `process.argv[1]` of the running CLI (the bin that was invoked) and `hierarchy-dispatch.mjs` passes its already-resolved bin through unchanged. Tests in `terminals.test.ts` that assert the bare `cli-hierarchy attach planner` string change to the array form.
- Each per-agent task carries `"isBackground": true` and the presentation settings the existing hand-written file used (`echo: false`, `clear: true`) so an attach that exits because the agent is not yet running does not pop an error dialog; the task's own output line from `attach` is enough.
- `cli-hierarchy up` regenerates the tasks file after it has written the roster, whenever at least one session was started or the roster changed, when `<cwd>/.vscode/tasks.json` either does not exist or was written by us. "Written by us" means the file carries a top-level `"ai-sdlc": { "generated": true, "roster": "<board-dir>/hierarchy.json" }` marker that `buildVscodeTasks()` adds; a file without the marker is never overwritten and `up` prints one line saying how to merge by hand (`terminals --vscode --print`). `down` leaves the file alone. The new `up` flag `--no-vscode-tasks` disables the regeneration for operators who manage the file themselves.
- When `up` detects it is running from a VS Code integrated terminal (`TERM_PROGRAM=vscode`, or `VSCODE_GIT_IPC_HANDLE` set, which also covers a tmux pane opened from VS Code), it ends its output with one line: `VS Code: run task "hierarchy: open all agents" (Terminal > Run Task) to open one terminal per agent`. Outside VS Code the line is omitted. Full automatic opening is AISDLC-755; this task only makes the manual step correct and one keystroke long.
- Document the marker, the regeneration rule, `--no-vscode-tasks` and the VS Code hint in `docs/operations/cli-hierarchy.md` and the help text in `pipeline-cli/src/cli/hierarchy.ts` together (`docs-parity.test.ts` binds them), and add a "VS Code terminals" recipe to `ai-sdlc-plugin/commands/hierarchy.md`.

Sequencing: AISDLC-755 (automatic terminal opening through a VS Code extension) builds on the marker and the regeneration rule defined here and should be dispatched after this task merges.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] `cli-hierarchy terminals --vscode --print` emits `command: "node"` plus an `args` array whose first element is the absolute path of the invoked `cli-hierarchy.mjs`; running one generated task from a shell where `cli-hierarchy` is not on `PATH` attaches to the agent.
- [x] After `cli-hierarchy up --executors 5` in a repo with no `.vscode/tasks.json`, the file exists, lists all seven agents plus "hierarchy: open all agents", and carries the `ai-sdlc.generated` marker; a second `up` that starts nothing leaves the file byte-identical.
- [x] A hand-written `.vscode/tasks.json` without the marker is never modified by `up`; `up` prints the merge-by-hand hint once. `--no-vscode-tasks` skips regeneration entirely.
- [x] With `TERM_PROGRAM=vscode` in the environment, `up` prints the "run task" hint as its last line; without it, no hint. Covered by a test in `hierarchy.test.ts` that drives `up` with an injected environment.
- [x] `terminals.test.ts` covers the array-form command, the marker, and the refusal to overwrite an unmarked file; `docs-parity.test.ts` passes with the new flag in both the help text and `docs/operations/cli-hierarchy.md`.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass apart from the pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), disclosed in the PR body.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`cli-hierarchy up` now keeps `.vscode/tasks.json` correct: generated tasks run `node <abs cli-hierarchy.mjs> attach <name>`, carry `isBackground` plus `echo:false`/`clear:true`, and the file is marked `ai-sdlc.generated` so `up` regenerates it only when absent or ours.

## Changes
- `pipeline-cli/src/hierarchy/terminals.ts` (modified): array-form command, marker, safe sync (never overwrites unmarked/symlinked files).
- `pipeline-cli/src/hierarchy/up.ts`, `types.ts`, `pipeline-cli/src/cli/hierarchy.ts` (modified): regeneration, `--no-vscode-tasks`, VS Code run-task hint.
- Tests, `docs/operations/cli-hierarchy.md`, `ai-sdlc-plugin/commands/hierarchy.md` (modified).

## Design decisions
- **Regenerate only on change**: a no-op second `up` leaves the file byte-identical.
- **Write failure is a warning**, not an error.

## Verification
- `pnpm build` — clean
- `pnpm test` — pass apart from pre-existing pipeline-cli failures (verify-runtime 3, bin-invocation 4, TUI 7)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews approved

## Follow-up
declined: AISDLC-755 already filed for automatic terminal opening
<!-- SECTION:FINAL_SUMMARY:END -->
