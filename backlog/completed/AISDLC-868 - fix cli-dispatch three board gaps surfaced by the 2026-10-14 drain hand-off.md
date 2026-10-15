---
id: AISDLC-868
title: 'fix(cli-dispatch): three board gaps surfaced by the 2026-10-14 drain hand-off'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [bug, dispatch, hierarchy]
dependencies: []
references:
  - pipeline-cli/src/dispatch
  - pipeline-cli/src/hierarchy/brief-format.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Context

The 2026-10-14 drain hand-off exposed three gaps in the dispatch board commands. Each forced the dispatch session to work by hand.

- (a) `cli-dispatch remove-verdict --from failed` removes only the verdict; the manifest stays in `failed/`, so a stale entry is never fully cleared (this is also the AISDLC-800 invariant: a task in `backlog/completed` must not keep a failed manifest).
- (b) `cli-dispatch resume --failing-checks "Backlog Drift,Build & Test (Node 22)"` splits on whitespace instead of commas; the manifest recorded `["Backlog","Drift","Build","&",...]`.
- (c) `cli-hierarchy brief` ingestion refuses the WHOLE brief when any YAML task is already on the board (for example a resume), so dispatch had to enqueue by hand.

## Fix

**Five-step review (requirements first).** Requirement questioned: "ingestion fails closed on any already-on-board entry" (written to avoid double enqueue; it should skip the entry, not refuse the brief). Nothing to delete. Simplified: one ingestion path that tolerates resumes, instead of brief ingestion plus a hand-enqueue fallback. Accelerated: dispatch ingests a mixed brief in one command. Automated: node tests pin each of the three behaviours.

- (a) `remove-verdict --from failed` also removes the manifest (add `--with-manifest`, or make it the default when the task id is in `backlog/completed`; pick the one that keeps the AISDLC-800 invariant without surprising a live resume).
- (b) `--failing-checks` splits on commas only, trims each item, and keeps spaces, ampersands and parentheses inside a name.
- (c) `cli-hierarchy brief` skips entries already on the board, reports each skipped task id and its board state, and ingests the rest.

## Acceptance Criteria

- [x] AC-1: node test for (a): after `remove-verdict --from failed` (with the chosen flag or default), neither verdict nor manifest remains in `failed/`.
- [x] AC-2: node test for (b) using the real check names `Backlog Drift` and `Build & Test (Node 22)`; manifest holds exactly two entries.
- [x] AC-3: node test for (c): a brief with one already-on-board task and two new ones ingests the two and reports the skipped one; exit code is success.
- [x] AC-4: `docs/operations/cli-hierarchy.md` documents all three behaviours.

## Out of scope

Changes to the tick classifier (AISDLC-823) and to claim or reap semantics.

## Final Summary

Closed by AISDLC-882: `cli-dispatch resume` is gone (item b with it), and `reenter` moves the failed verdict and manifest copy to `landing/<pr>/history/` so `failed/` keeps no manifest (item a). Item c (brief ingestion refusing an already-on-board task) is not changed here; re-file it if it recurs.
