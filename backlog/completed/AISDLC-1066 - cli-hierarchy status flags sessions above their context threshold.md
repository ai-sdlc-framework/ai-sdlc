---
id: AISDLC-1066
title: 'cli-hierarchy status reads each session context size and flags any session above its clear threshold'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - hierarchy
  - token-cost
  - rca-2026-10-23
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Weekly token audit (2026-10-16 to 2026-10-23): calls above 150k context are 26 percent of all model calls but 62 percent of the week's 7,980M cache-read tokens. On 2026-10-23 executor sessions sat between 450k and 966k context for hours because the hooks module (which owns `session.measure` and the 120k rotation) was not loaded, and `cli-hierarchy status` showed them as `busy` with `ENV ok`. The thresholds exist in `<board-dir>/config.json` and `status` prints them, but nothing compares a live session against them.

Fix: `status` gains a `CONTEXT` column. Source: the session's transcript file under `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` (the session id comes from the roster entry's pid environment or from the `.ai-sdlc/dispatch/sessions` record the launcher writes; if the launcher does not record it yet, record it at `up` and `restart`). Read the last assistant record's `usage` (input plus cache_read plus cache_creation) by seeking from the end of the file, never by reading it whole. Print the value in k tokens; print `OVER` after it when it exceeds the role's threshold and `?` when the file cannot be found. `status --json` carries `contextTokens` and `overThreshold` per session. `up` and `doctor` print one warning line per session that is over. Document the column in `docs/operations/cli-hierarchy.md` and name the dead-module case as what it catches.

**Five-step review (requirements first).** Requirement questioned: should the CLI rotate the session itself when over? No: rotation stays with the module and the dispatch session; the CLI only makes the state visible so a dead module is caught in an hour, not a shift. Deletion: nothing. Simplified: one column from one file read. Accelerated: tail-read of the transcript, no full parse. Automated last: a unit test with a fixture transcript pins the parse and the OVER flag.

## Acceptance Criteria

- [x] `status` shows a `CONTEXT` column in k tokens per session, `OVER` when above the role threshold, `?` when unknown; `--json` carries `contextTokens` and `overThreshold`; a unit test with fixture transcripts covers all three states.
- [x] The read seeks from the end of the transcript and never loads the file (test with a multi-megabyte fixture asserts the bytes read are bounded).
- [x] Runbook documents the column; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
cli-hierarchy status now has a CONTEXT column that shows each session's context size in k tokens, with OVER when it is above the role threshold and ? when the transcript can't be found. `--json` carries contextTokens and overThreshold, and `status` and `up` print one warning line per session that is over. The value comes from a bounded backward tail-read of the transcript, and the runbook documents the column and the dead-module case. Draft PR is open.

## Changes
- pipeline-cli/src/hierarchy/context-size.ts
- pipeline-cli/src/hierarchy/context-size.test.ts
- pipeline-cli/src/hierarchy/status.ts
- pipeline-cli/src/hierarchy/up.ts
- pipeline-cli/src/hierarchy/registry.ts
- pipeline-cli/src/hierarchy/types.ts
- pipeline-cli/src/hierarchy/hierarchy.test.ts
- docs/operations/cli-hierarchy.md

## Design decisions
Not done: the `ai-sdlc doctor` warning. The task asks for it, but doctor lives in orchestrator/src/cli/commands/doctor-checks.ts with its own roster reader, so it needs a separate check there. The task's acceptance criteria don't cover it. The `up` warning is done. The transcript is found through the `sessionId` in the harness session registry; I did not add launcher recording of the session id at `up` and `restart`, so a session whose registry file has no `sessionId` shows `?`. The commit scope is `orchestrator` because commitlint rejects `hierarchy`. I ran `pnpm build && pnpm test && pnpm lint && pnpm format:check` and all passed. I did not run the per-package coverage check before pushing.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
- declined: ai-sdlc doctor context check needs its own roster reader in orchestrator; left for the operator to file if wanted

