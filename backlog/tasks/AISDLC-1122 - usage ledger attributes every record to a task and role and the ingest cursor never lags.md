---
id: AISDLC-1122
title: usage ledger attributes every record to a task id, role and session, ingests every transcript directory including worktrees and subagents, and a per-task cost view replaces the gross session view
status: In Progress
assignee: []
created_date: '2026-10-30'
labels:
  - usage
  - cost
  - hierarchy
priority: high
references:
  - pipeline-cli/src/usage/ingest-claude.ts
  - pipeline-cli/src/cli/usage.ts
  - pipeline-cli/src/usage/attribution.ts
  - docs/operations/cli-hierarchy.md
---

## Description

A token audit over 2026-10-23 to 2026-10-30 had to be rebuilt from raw Claude Code transcripts because the usage ledger could not answer the operator's questions. The ledger covered 73 percent of in-window spend (24 to 82 percent per day; the ingest cursor lagged by up to a day), carried a task id on 2.7 percent of records, and had no role or session kind, so neither per-task cost nor per-role cost (planner, dispatch, executor, developer, reviewer) was visible. The budget pacer (AISDLC-1072, AISDLC-1076) will pace on these numbers; today it would pace on a quarter of the spend with no attribution.

**Five-step review (requirements first).** Requirement questioned: do we need a ledger at all when the transcripts hold the data? Yes: the transcripts are per machine, large, and unreadable to the pacer; the ledger is the one place the pacer and the operator read. Deletion: delete the gross session view, which is dominated by polling and misleads. Simplified: one attribution rule, the active-task sentinel and the roster name at the time of the record. Accelerated: ingest runs from the tick, not from an operator command. Automated: every tick ingests what is new; no catch-up runs.

## Fix

1. `pipeline-cli/src/usage/ingest-claude.ts`: walk every project directory for the repo including `--worktrees-*` directories and subagent subdirectories; stamp each record with `taskId` from the worktree's `.active-task` sentinel or the executor roster name, `role` from the roster (planner, operator-dispatch, executor) or the subagent type (developer, code-reviewer, security-reviewer, Explore, general-purpose), and `sessionId`. Store the ingest cursor per transcript file; the tick calls ingest each time it runs so lag is one tick.
2. `pipeline-cli/src/cli/usage.ts` (and `pipeline-cli/src/usage/attribution.ts` for the attribution rule): add `by-task` (work spend, with polling and idle turns shown separately), `by-role`, and `by-day` views with cache read, cache write, fresh input and output columns and the list-price estimate; delete the gross session view.
3. `docs/operations/cli-hierarchy.md`: how spend is attributed and which view the pacer reads.

## Velocity impact

Neutral on throughput; gives the pacer and the operator the number they act on, and makes the next audit a one-command report instead of a transcript crawl.

## Acceptance Criteria

- [ ] After one tick, every assistant record from the last hour in every project directory of this repo (parent, worktrees, subagents) is in the ledger with `taskId`, `role` and `sessionId` set where the sentinel or roster gives them, and `role` is never empty for a roster session.
- [ ] `cli-usage by-task --since 7d` lists tasks with work spend and polling spend as separate columns; `by-role` and `by-day` exist; the gross session view is gone.
- [ ] Ledger coverage against a transcript recount for the same day is at least 98 percent.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Out of scope

- The pacer's own logic (AISDLC-1072, AISDLC-1076).
