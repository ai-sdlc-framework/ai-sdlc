---
id: AISDLC-393
title: 'feat: /ai-sdlc execute accepts GH issue numbers (not just backlog task IDs)'
status: In Progress
labels:
  - cli
  - dogfood
  - ux
references:
  - ai-sdlc-plugin/commands/execute.md
  - dogfood/src/cli-watch.ts
  - dogfood/src/cli.ts
  - CLAUDE.md
priority:
  level: P1
size:
  tshirt: M
---

## Description

`/ai-sdlc execute` currently only accepts backlog task IDs (`AISDLC-NNN`). To run a GH issue through the pipeline on subscription billing today, operators have to mirror the issue into a backlog task by hand — duplicate state across two trackers for the same unit of work. The alternative is `pnpm --filter @ai-sdlc/dogfood watch --issue <id>`, which is GH-native but runs on **API-key billing** and doesn't match the canonical internal flow.

The split exists for billing reasons (subscription vs API key), not workflow reasons. The friction shows up the moment a real bug is filed as a GH issue (e.g. #610) and the operator wants to dispatch it on subscription. The right fix is to make the slash command accept the GH issue form and route internally, reusing what the watcher already does.

This task tracks #612.

## Acceptance criteria

- [x] AC-1: `/ai-sdlc execute <arg>` detects the argument form:
  - `^[A-Za-z][A-Za-z0-9]*-\d+$` (a prefixed task id like `AISDLC-NN` or `INGEST-NN`) → existing backlog-task path, no behavior change
  - `^#?\d+$` (a bare numeric or hash-prefixed numeric form) → new GH-issue path
  - `^gh:\d+$` (a `gh:`-prefixed explicit form) → unambiguous routing for the GH-issue path
- [ ] AC-2: On the GH-issue path, the slash command reuses `dogfood/src/cli-watch.ts` (or refactored shared helper) to fetch the issue, run admission scoring, set up the per-task worktree, and dispatch — same logic the watcher already implements.
- [ ] AC-3: The GH-issue dispatch path uses the **subscription `SubagentSpawner`** (the same one `/ai-sdlc execute <task-id>` uses today), not the API-key spawner the watcher uses.
- [ ] AC-4: No backlog task file is created as a side effect when dispatching from a GH issue. The GH issue remains the single source of truth; the PR closes the issue directly via `Closes #N` in the PR body.
- [ ] AC-5: The opened PR title and body reference the GH issue (`(closes #N)` in the conventional-commits subject, `Closes #N` in the body).
- [x] AC-6: When `/ai-sdlc execute` is invoked with an argument that doesn't match either form, exit with a clear error message listing the accepted forms — no silent failure.
- [x] AC-7: The existing watcher path (`pnpm --filter @ai-sdlc/dogfood watch --issue <id>`) is preserved unchanged for the API-key/unattended/CI use case.
- [x] AC-8: `CLAUDE.md` "Canonical execution paths" table updated to reflect that the slash command now accepts either form. Old "GitHub issue / unattended / CI → watcher" row remains; the slash-command row gains the GH-issue capability for subscription dispatch.
- [x] AC-9: Hermetic test coverage at the slash-command parser layer (form detection: AISDLC-NNN, NNN, #NNN, gh:NNN, malformed). Existing watcher tests left untouched.

## Partial ship status (AISDLC-393)

ACs shipped: 1, 6, 7, 8, 9 — argument parser + error path + docs + tests.

ACs deferred (architectural decision required, see PR notes):
- AC-2, AC-3, AC-4, AC-5 — actual GH-issue dispatch through `executePipeline`. The implementation sketch in this task assumes `cli-watch.ts` has a "GH-issue→pipeline codepath" to refactor, but that codepath does not exist: `cli-watch.ts` today just forwards its `--issue <id>` to `executePipeline({ taskId: issueId })` which only handles backlog task files. Routing a GH issue through `executePipeline` requires extending pipeline-cli to either (a) accept an in-memory `TaskSpec` (bypassing `validateTask`'s file load + Step 4 `task_edit` + Step 10 `task_complete` for the issue path), or (b) add an `executePipelineFromIssue()` composite, or (c) materialize an ephemeral gitignored task file in the worktree. Each option has tradeoffs that warrant an operator/architect call.

Operator workaround until AC-2/3/4/5 land: continue using `pnpm --filter @ai-sdlc/dogfood watch --issue <N>` for GH-issue dispatch (API-key billing). The slash-command path exits with a clear pointer to this workaround when the parser routes to the GH-issue branch.

## Implementation sketch

1. Refactor the GH-issue→pipeline codepath out of `dogfood/src/cli-watch.ts` into a shared helper (e.g. a new dispatch-from-issue module under dogfood/src/) that takes a `SubagentSpawner` injection point per RFC-0012.
2. The watcher continues to pass the API-key spawner; the slash command's GH-issue branch passes the subscription spawner.
3. In the slash-command entry (`ai-sdlc-plugin/commands/execute.md` body, or wherever the parsing actually lives), add the argument-form detection and route to the right handler.
4. Update `CLAUDE.md` canonical-execution-paths table.

## Out of scope

- Cross-repo dispatch (`owner/repo#NNN`)
- Bidirectional GH-issue sync (the issue stays authoritative; the pipeline writes back only via PR close)
- Backwards-compat for the legacy mirror-to-backlog flow (just deprecate it; nothing was officially documented as the supported path)

## References

- GH issue #612 — the source ask
- GH issue #610 — concrete instance of the friction (symlink bug filed as GH issue, can't dispatch on subscription today)
- `CLAUDE.md` → "Canonical execution paths"
- RFC-0012 — Two-tier pipeline architecture; the `SubagentSpawner` injection point is the rail-swap seam
- `dogfood/src/cli-watch.ts` — current GH-native dispatch implementation
