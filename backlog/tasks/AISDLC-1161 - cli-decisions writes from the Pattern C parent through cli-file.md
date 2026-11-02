---
id: AISDLC-1161
title: 'cli-decisions add|answer|escalate --file writes a decision event from the Pattern-C parent through cli-file own worktree and PR, so planners stop hand-moving events out of throwaway worktrees'
status: To Do
assignee: []
created_date: '2026-11-02'
labels:
  - decisions
  - cli-file
  - pattern-c
dependencies: []
references:
  - pipeline-cli/src/decisions/catalog-root.ts
  - pipeline-cli/src/decisions/catalog-root.test.ts
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/file.test.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

The planner has no sanctioned way to record a decision. Two shipped rules contradict each other:

- `resolveWriteRoot` (`pipeline-cli/src/decisions/catalog-root.ts:52`, AISDLC-874) refuses `add`, `answer` and `escalate` (`decisions.ts:862`, `:1067`, `:1865`) from the Pattern-C parent with no `AI_SDLC_ACTIVE_TASK_ID` (`catalog-root.ts:67`, "refusing to write from the Pattern-C parent").
- `fileDecision` (`pipeline-cli/src/cli/file.ts:568`), the path `planner.md` mandates for decision records ("File every backlog task and decision record with `cli-file`, never by hand"), reads the `decision-opened` event from the parent's own store (`readStoreEvents(repo)`, `file.ts:578`; refuses at `file.ts:603` when absent) and then deletes the parent copies (`file.ts:658`). It therefore expects the event to already sit untracked in the parent, which AISDLC-874 forbids.

The workaround in use: create a throwaway worktree (`.worktrees/dec-0291`), run `cli-decisions add`/`answer` there, then either move the event files to the parent by hand or run `cli-file` from inside it, which nests a filing worktree (`git worktree list` today shows a prunable `.worktrees/dec-0291/.worktrees/file-dec-0291`). Both are unsanctioned manual steps on the governance record.

Related gap found while reading: `resolve` (`decisions.ts:1998`), `auto-expire` (`:2085`), `override` (`:2187`), `extend` (`:2318`) and `score-c` (`:1478`) still write with `argv['work-dir']` (the main checkout via `resolveCatalogRoot`), so from a worktree they bypass AISDLC-874 and land untracked in the parent.

**Five-step review (requirements first).**
1. Requirement questioned: must a decision event ever exist as an untracked file in the parent? No. It must reach `main` through a reviewed PR; the parent copy is only a staging artefact.
2. Delete: the throwaway-worktree step and the hand move; the staging copy in the parent.
3. Simplify: one flag, `--file [--pr]`, on `add`, `answer` and `escalate`. With it, the CLI builds the event in memory and hands it to `fileDecision` (new optional `events` input), which already materialises events into its own `.worktrees/file-<dec>` from `origin/main` and opens the PR. `resolveWriteRoot` accepts the parent when `--file` is set; without `--file` the AISDLC-874 refusal stays, and its message names `--file`. `fileDecision` looks up `decision-opened` in the in-memory events, then local, then `origin/main`, so answering a decision already on main needs no local copy.
4. Accelerate: one command from the parent replaces worktree creation, two CLI calls and a file move.
5. Automate: the `resolve`/`override`/`extend`/`auto-expire`/`score-c` writers go through `resolveWriteRoot` too, so the AISDLC-874 rule holds for every writer, with a test that enumerates the writing subcommands.

Velocity impact: every planner-authored decision (several per day) drops from about five manual steps to one, and the governance record stops depending on hand-moved files.

## Acceptance Criteria

- [ ] AC-1: `cli-decisions add ... --file --pr` run from the Pattern-C parent with no active task opens a `ai-sdlc/file-dec-nnnn` PR containing the `decision-opened` event and writes nothing into the parent's `.ai-sdlc/_decisions/events/`; a test asserts the parent store is unchanged.
- [ ] AC-2: `cli-decisions answer <id> <option> --file --pr` from the parent files the `operator-answered` event for a decision whose `decision-opened` is only on `origin/main`; the same duplicate-pair and option-validity checks as `fileDecision` apply.
- [ ] AC-3: Without `--file`, the parent refusal in `resolveWriteRoot` is unchanged and its message names `--file` as the sanctioned path.
- [ ] AC-4: `resolve`, `override`, `extend`, `auto-expire` and `score-c` resolve their write root with `resolveWriteRoot` (and accept `--file`); a test lists every subcommand that calls `appendDecisionEvent` and asserts each uses the write root.
- [ ] AC-5: `planner.md` and `docs/operations/decision-authority.md` show the one-command form (`cli-decisions add ... --file --pr`) and drop any worktree workaround text.

## Notes

Origin: planner sessions authoring DEC-0287..DEC-0291 in throwaway worktrees (`.worktrees/dec-0291`, nested filing worktree still listed as prunable on 2026-11-02). Related: AISDLC-874 (write-root refusal), AISDLC-825 (catalog root), AISDLC-801 (cli-file), AISDLC-1160 (queued `--answer` replay), AISDLC-1162 (supersede event, which should use the same `--file` path).
