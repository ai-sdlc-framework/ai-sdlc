---
id: AISDLC-1160
title: 'cli-file --pr --queue writes the queued brief from the real argv, so a queued `decision --answer` (and every other flag) replays intact'
status: In Progress
assignee: []
created_date: '2026-11-02'
labels:
  - cli-file
  - decisions
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/file-pacing.ts
  - pipeline-cli/src/cli/file-pacing.test.ts
  - pipeline-cli/src/cli/file.test.ts
priority: medium
dispatchable: true
---

## Description

`cli-file decision DEC-NNNN --task-id <id> --answer <option> --pr --queue`, when the AISDLC-986 spacing has not elapsed, writes `.ai-sdlc/dispatch/queued-filings/filing-dec-nnnn.md` whose `Run:` line omits `--answer` and `--rationale`. Replaying that line files only the events already in the local store and never appends the `operator-answered` event, so the decision lands open (or the run refuses with "nothing to file").

Cause: `runFileCli` (`pipeline-cli/src/cli/file.ts`) hand-assembles the replay string passed to `paced()` instead of using the arguments it was given:

- `decision` (file.ts:897): `` `cli-file decision ${a.id} --task-id ${a.taskId} --pr` `` drops `--answer` and `--rationale`.
- `task` (file.ts:871): `` `cli-file task ${a.path} --pr` `` drops `--no-brief`, `--fixes-pr` and `--update`.
- `rebase` (file.ts:925): `` `cli-file rebase ${a.id} --pr` `` drops `--source`.

`queueFiling` (`file-pacing.ts:83`) writes that string verbatim into the brief. The existing test (`file-pacing.test.ts:73`) passes a literal command, so nothing exercises the CLI's assembly.

**Five-step review (requirements first).**
1. Requirement questioned: must a queued brief replay exactly the filing the operator asked for? Yes; a brief that silently drops the answer files a different record than the one ruled on.
2. Delete: the three hand-built command strings in `runFileCli`.
3. Simplify: build the replay line once from the received argv (`cli-file ` + the original arguments, shell-quoted, with `--queue` and `--spacing-minutes` removed), so every present and future flag is carried.
4. Accelerate: a queued answer can be replayed by copy-paste with no re-derivation of the ruling.
5. Automate: a CLI-level test per subcommand asserts the brief's `Run:` line equals the input argv minus the pacing flags.

Velocity impact: removes a silent data-loss path from the filing queue; no re-filing round when a queued answer lands without its `operator-answered` event.

## Acceptance Criteria

- [ ] AC-1: `runFileCli` derives the queued `command` from the argv it was called with (shell-quoted, `--queue` and `--spacing-minutes` stripped); no subcommand hand-assembles its replay string.
- [ ] AC-2: A test runs `decision DEC-0001 --task-id X-1 --answer opt-a --rationale "two words" --pr --queue` with the spacing not elapsed and asserts the brief's `Run:` line contains `--answer opt-a` and the quoted rationale, and no `--queue`.
- [ ] AC-3: Equivalent tests for `task ... --no-brief --fixes-pr 12 --update --pr --queue` and `rebase <id> --source <path> --pr --queue` assert every flag is carried.
- [ ] AC-4: Replaying the `Run:` line of the AC-2 brief (spacing elapsed, fake deps) appends an `operator-answered` event with `chosenOptionId: opt-a`.
- [ ] AC-5: `cli-file task` runs the backlog-drift check against the task file it is filing, not the parent checkout: today `validateTaskSource` calls `deps.drift(id, repo)` with `repo` = the parent, so a source outside `backlog/tasks/` (scratchpad) is not yet present there and drift passes with no report. Run drift in the filing worktree after the file is copied in (or against a temp copy), and add a test where a scratchpad source references a missing path and cli-file refuses with the `ref-deleted` error. Observed: AISDLC-1159 (#2296) filed with a bad reference, caught only by CI Backlog Drift.

## Notes

AC-5 added by the planner 2026-11-02: CI Backlog Drift on PR 2296 failed on a reference that cli-file had passed.

Origin: planner observation 2026-11-02, noted against AISDLC-986 (cli-file pacing, completed). Only `--answer` was reported; reading `runFileCli` showed the same defect on `task` and `rebase` flags.
