---
id: AISDLC-1405
title: 'DEC-0091 contradicts the operator ruling on its re-recorded copy DEC-0092'
status: In Progress
assignee: []
created_date: '2026-11-24'
labels:
  - decision-catalog
  - pipeline-cli
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.ts
  - .ai-sdlc/_decisions/events
priority: high
---

## Description

**Five-step review (requirements first).** The catalog must show the operator's ruling and nothing that contradicts it (RFC-0035, DEC-0039). That holds. Nothing is deleted from the append-only log; the fix closes the stale record and finds the writer.

**Gap.** On 2026-10-10 the planner recorded the check-sender guard decision as DEC-0091 (timebox PT10H, fallback `keep-fix-806`), then re-recorded it as DEC-0092 because DEC-0091 had already been allocated in PR #1344. DEC-0091 was left open. The operator answered DEC-0092 `delete-guard` on 2026-10-11T16:00Z. On 2026-10-13T04:47:09Z an `operator-answered` event answered DEC-0091 `keep-fix-806`: no `by`, no rationale, and it matches the fallback. It landed via the sync commit 31b4f4fe1 (#1457). Today both records read "answered" with opposite choices. The code follows the operator: check-sender is gone from `pipeline-cli/src` and the executor command. Only the record contradicts the ruling.

**Cause: unverified.** Today's `auto-expire` writes the rationale `fallback after <timebox> timebox`, so it is probably not the writer, unless an older build was. Find which path wrote a bare `operator-answered` (an older auto-expire, a `cli-decisions answer` without `--rationale` or `by`, or a hand-edited sync).

## Fix

- Close DEC-0091 as superseded by DEC-0092 (`cli-decisions supersede`, or a new event type if supersede refuses answered records), so `list`/`show` show DEC-0092's ruling as current.
- Identify the writer of the 2026-10-13 event from git history and the code at that date; write the finding in the PR body.
- If that writer still exists, make it stamp `by` and a rationale, and make a timebox fallback skip a decision whose summary matches an already-answered decision.

## Acceptance Criteria

- [ ] #1 `cli-decisions show DEC-0091` marks it superseded by DEC-0092; `list --route design` no longer shows two answered records with opposite choices.
- [ ] #2 The PR body names the writer of the 2026-10-13T04:47:09Z event, with the commit or code path as evidence.
- [ ] #3 If the writer still exists: a test shows its event carries `by` and a rationale.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
