---
id: AISDLC-1405
title: 'DEC-0091 contradicts the operator ruling on its re-recorded copy DEC-0092'
status: Done
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
- [x] #2 The PR body names the writer of the 2026-10-13T04:47:09Z event, with the commit or code path as evidence.
- [x] #3 If the writer still exists: a test shows its event carries `by` and a rationale.
- [x] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

Fixed both round-1 review findings. resolve and resolveDorDecision now refuse a write with no by or no rationale, using the same guard as answer. supersede (CLI and projection fold) now closes only the exact DEC-0091 shape through one shared predicate, isUnattributedFallbackAnswer. Checked against this branch's full event log, that predicate matches DEC-0091 and no other record.

## Changes

- pipeline-cli/src/cli/decisions.ts
- pipeline-cli/src/cli/decisions.test.ts
- pipeline-cli/src/decisions/projection.ts
- pipeline-cli/src/decisions/projection.test.ts
- pipeline-cli/src/decisions/dor-bridge.ts
- pipeline-cli/src/decisions/dor-bridge.test.ts
- pipeline-cli/src/decisions/dor-integration.test.ts

## Design decisions

This was a resumed round: I committed only and did not push. Finding 1: a new helper, requireAnswerAttribution in /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1405/pipeline-cli/src/cli/decisions.ts, guards both answer and resolve. A blank or missing --by or --rationale is refused and nothing is written. resolveDorDecision in /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1405/pipeline-cli/src/decisions/dor-bridge.ts now takes by and rationale as required options, throws on a blank one and writes both on the event. It has no production callers, only tests, which I updated. Finding 2: isUnattributedFallbackAnswer is exported from /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1405/pipeline-cli/src/decisions/projection.ts and used by both the superseded fold and the supersede CLI, so the two cannot drift. It is true only when all of these hold: lifecycle is answered, answeredBy is null, the chosen option equals spec.autonomousFallbackOptionId, and the latest answering event is operator-answered with an empty rationale. Projected over this branch's full event log, it matches DEC-0091 and nothing else, so the 94 older unattributed answers stay final. I also updated the PR body through the REST API, because gh pr edit failed on a GraphQL deprecation error from Projects classic. AC1 still needs a catalog write after merge: the executor role policy refuses supersede for the developer session. As escalated in DEC-0441, the planner or dispatch runs supersede DEC-0091 --by DEC-0092 with a reason, --actor planner, --file and --pr. The new tests show that command succeeds for the DEC-0091 shape.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

- declined: AC1 catalog write is already tracked as DEC-0441 for the planner after merge
