---
id: AISDLC-933
title: 'fix(hierarchy): handoff write keeps one current notes block and rolls older prose into an archive file'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, reliability, planner, velocity]
dependencies:
  - AISDLC-889
references:
  - pipeline-cli/src/hierarchy/handoff.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Context

Operator question 2026-10-15: "Why are you constantly getting the stale handoff first?" The planner handoff file had grown to 250 KB: 172 timestamped log lines above the CLI markers (2026-10-10/11) and fifteen `## RESUME HERE` blocks below them, one per clear, never removed. `handoff write` regenerates only the text between the markers and keeps everything else, so the file grows by one block per clear; `handoff read` and the SessionStart reload then surface the oldest prose first (AISDLC-889 bounds the read side). The planner pruned the file by hand on 2026-10-15 (one current block, history moved to `project_planner_handoff_2026_10_15_archive.md`) and the index line in `MEMORY.md` now says "replace, never append". Nothing enforces that: the next planner that appends instead of replacing starts the pile-up again.

**Five-step review (requirements first).** Requirement questioned: "text outside the markers is kept on every rewrite" (so a clear loses nothing). Kept, but bounded: a session needs the newest notes, not every block ever written. Delete: nothing in the CLI; the hand-pruned history is already out of the live file. Simplify: `handoff write` keeps exactly one notes section (the newest `## RESUME HERE` block, or the tail of the prose when there is none) in the live file and appends every older block to `<file>_archive.md`, so the live file stays small without a human remembering the rule. Accelerate: nothing. Automate: deterministic, no model call (automation ladder rung 1). Scope: complements AISDLC-889, which bounds what is read; this bounds what is kept.

## Fix

1. `handoff.ts`: after splicing the generated block, split the prose outside the markers into `## RESUME HERE` blocks (heading match, case-insensitive). Keep the last block (plus any prose after it) in the live file; move every earlier block, and any prose before the markers that is not frontmatter or the fixed header lines, to `<basename>_archive.md` next to the live file, appended in order with a dated separator. Never delete text: every byte removed from the live file lands in the archive. Idempotent: a second write with nothing new moves nothing.
2. `cli/hierarchy.ts` `handoff write`: report `archivedBlocks` and `archiveFile` in the JSON result; `--no-archive` keeps today's behaviour.
3. `planner.md` Handoff routine and `docs/operations/cli-hierarchy.md`: notes go in ONE `## RESUME HERE` block at the end of the file; a new block replaces the old one at the next write (the old one is in the archive, named in the write output).
4. Tests: `handoff.test.ts` cases for three blocks (one kept, two archived in order, archive appended not overwritten), no block (tail kept, nothing archived), rewrite with no new block (nothing moves), `--no-archive`.

## Acceptance Criteria

- [ ] #1 `cli-hierarchy handoff write --role planner` on a file with N `## RESUME HERE` blocks leaves exactly one in the live file and appends the N-1 older ones to `<basename>_archive.md`, reporting `archivedBlocks` and `archiveFile`.
- [ ] #2 A second write with no new block archives nothing and leaves both files byte-identical.
- [ ] #3 Prose before the markers that is not frontmatter or header is archived too, so the generated block is the first content after the header.
- [ ] #4 `--no-archive` writes the block only, as today.
- [ ] #5 `planner.md` and `docs/operations/cli-hierarchy.md` describe the one-block rule and the archive file.
- [ ] #6 Vitest cases cover AC #1-#4.

**Velocity impact.** Positive: removes the manual prune and the "read the wrong block" orientation loss on every planner clear; no new gate.

**Ordering.** After AISDLC-889 (its `renderHandoffView` and marker placement are what this task's archive split relies on).

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, memory files only, no trust-chain control); operator instruction 2026-10-15 ("file it").
