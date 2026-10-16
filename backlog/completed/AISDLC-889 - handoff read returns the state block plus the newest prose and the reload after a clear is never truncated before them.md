---
id: AISDLC-889
title: 'fix(hierarchy): handoff read returns the state block plus the newest prose, and the SessionStart reload after a clear is never truncated before them'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [hierarchy, reliability, planner, velocity]
dependencies:
  - AISDLC-886
references:
  - pipeline-cli/src/hierarchy/handoff.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/hooks/lib/hierarchy-role.js
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Context

Operator report 2026-10-14: the planner resumed after an auto-clear with the 2026-10-10 state ("everything parked behind #1410") although the handoff file held a block written at 19:50Z the same day. Trace (planner transcripts, four auto-clears on 2026-10-14 at 16:15Z, 16:47Z, 17:14Z, 19:02Z, all the same shape):

- `cli-hierarchy handoff write` runs before every clear and succeeds; it splices the CLI-generated block between the first `<!-- ai-sdlc-handoff:begin -->` / `:end -->` markers of `.claude/memory/project_planner_handoff_2026_10_10.md` (`handoff.ts` `splice`). That file is 217 KB and 626 lines; the markers sit at lines 191-217, about 70 KB in, because the prose the planner writes outside the markers has accumulated on both sides of it (eight `## RESUME HERE` blocks between lines 445 and 620, plus a "CURRENT STATE" block at the top that points at "~line 600").
- `SessionStart(clear)` calls `readHandoffText` (`ai-sdlc-plugin/hooks/lib/hierarchy-role.js`), which runs `handoff read` and keeps the first `HANDOFF_MAX_CHARS = 12000` characters of the whole file followed by `[handoff truncated]`. The cut lands in the 10-10 prose; the generated block and every `RESUME HERE` block are after it, so the cleared session never sees them.
- `handoff read` itself returns the whole file (65 KB) with no ordering, so reading it by hand has the opposite problem: it floods the window.

AISDLC-886 rotates the file to today's date and adds the auto-clear log; AISDLC-870 gives the session a turn to write its notes before the clear. Neither changes what a cleared session reads back, so after both land the notes written in that turn would still be cut off. This task closes that gap and is ordered between them.

**Five-step review (requirements first).** Requirement questioned: "the reload shows the handoff file". A resumed session needs two things only: the small CLI-generated state block (roster, board, open decisions) and the newest prose its predecessor wrote; everything else in the file is history that the memory index already points at. Delete: the top-of-file 12,000-character slice in `hierarchy-role.js`. Simplify: `handoff read` returns a fixed-order, bounded view (block first, newest prose second) and the reload prints exactly that view, so the plugin hook no longer decides what to keep. Accelerate: nothing; one file read. Automate: already deterministic, no model call (automation ladder rung 1).

## Fix

1. `handoff.ts`: add `renderHandoffView(content, { proseMaxChars })` returning, in order, (a) the generated block between the markers, (b) a `## Session notes (newest last)` section holding the last `proseMaxChars` characters of the text outside the markers (default 8,000; cut on a line boundary, prefixed with `[earlier notes omitted: N characters]` when cut), then (c) one line naming the file path so the session can `tail`/`grep` the rest. The newest prose is the end of the file: that is the convention `planner.md` already states ("append a dated line ... outside the markers"), and the one top-of-file block written on 2026-10-14 is the exception that caused the loss.
2. `cli/hierarchy.ts` `handoff read`: print the view by default; `--full` prints the whole file as today. `handoff write` unchanged except that, when the markers are missing, it inserts the block right after the frontmatter instead of appending at the end, so a fresh (rotated by AISDLC-886) file is block-first from the start.
3. `hierarchy-role.js` `readHandoffText`: drop `HANDOFF_MAX_CHARS` slicing; pass the view through unchanged (the CLI bounds it). Keep the null-on-failure path. `session-start.js` unchanged.
4. `planner.md` Handoff routine and `docs/operations/cli-hierarchy.md`: state that notes go at the END of the file outside the markers, that the reload shows the block plus the last ~8 KB of notes, and that `handoff read --full` or the file path gives the rest. Remove the "~line 600" style pointers from the routine text.
5. Tests: `handoff.test.ts` cases for a file with prose before and after the markers (block first, tail of prose, omitted-count line, line-boundary cut), markers missing (block inserted after frontmatter), and `--full`; `hierarchy-role.test.mjs` case that a 200 KB handoff reload contains the state hash line and the last note line and no `[handoff truncated]`.

## Acceptance Criteria

- [ ] #1 `cli-hierarchy handoff read --role planner` prints the generated block first, then the last 8,000 characters (default, line-boundary cut) of the prose outside the markers, then the file path; `--full` prints the whole file.
- [ ] #2 After `/clear`, the SessionStart reload for a 200 KB planner handoff contains the `state-hash` line and the last line written outside the markers, and never the string `[handoff truncated]`.
- [ ] #3 `handoff write` on a file without markers places the block immediately after the frontmatter, not at the end.
- [ ] #4 `ai-sdlc-plugin/commands/planner.md` and `docs/operations/cli-hierarchy.md` say notes go at the end of the file and describe the bounded view.
- [ ] #5 Unit tests cover AC #1-#3 (pipeline-cli Vitest) and AC #2 (plugin `node --test`).

**Velocity impact.** Positive: every planner clear today rebuilt its state from scratch (the 2026-10-14 loss cost a review restart and a wrong orientation); the reload becomes ~10 KB of current state instead of 12 KB of stale history.

**Ordering.** After AISDLC-886 (rotation creates the block-first file this task relies on); before AISDLC-870 (the notes 870 makes the session write must be the notes this task reads back).

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, no trust-chain control touched); operator-requested 2026-10-14 ("check what's filed before you file it, if it isn't filed yet then file it").
