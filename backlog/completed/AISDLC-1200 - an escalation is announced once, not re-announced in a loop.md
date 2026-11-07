---
id: AISDLC-1200
title: 'An escalation is announced once, not re-announced in a loop'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/hierarchy/escalation-file.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
priority: medium
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

**Source.** Planner session 2026-11-05; filed on operator go (decision rubric, 2026-11-06). Triaged; Unparked 2026-11-07 by operator ruling (planner critical-path review).

Between 2026-11-04 22:19 and 2026-11-05 09:57 local, 1230 escalation files were written for AISDLC-1190: the same escalation was re-announced on every tick. The loop has stopped, but nothing prevents it recurring.

**Scope narrowed 2026-11-07.** The planner-notification half is done: #2414 (AISDLC-1190) dedupes the planner line per task and message for an hour. What remains is the file writer: `writeEscalationFile` in `pipeline-cli/src/hierarchy/escalation-file.ts` (around line 55) writes a new file under `<boardDir>/escalations/` on every call with no check for an existing file for the same task, message and head; `.ai-sdlc/dispatch/escalations/` held 4798 files on 2026-11-07.

## Acceptance Criteria
- [x] #1 `writeEscalationFile` is idempotent for the same task, message and head: when a matching escalation file already exists it returns that file's path and writes nothing new.
- [x] #2 A test calls `writeEscalationFile` repeatedly (and runs repeated ticks through `dispatch-loop.ts`) against one escalation and asserts exactly one file in `escalations/`.
- [x] #3 A different message or head for the same task still produces a new file (test).

## Final Summary

## Summary
writeEscalationFile now returns the existing file when one already matches the same task, message and head (the failure record), so repeated calls write nothing new. A different message or failure record still writes a new file.

## Changes
- pipeline-cli/src/hierarchy/escalation-file.ts
- pipeline-cli/src/hierarchy/escalation-file.test.ts
- pipeline-cli/src/cli/hierarchy.test.ts
- backlog/tasks/AISDLC-1200 - an escalation is announced once, not re-announced in a loop.md

## Design decisions
I read 'head' as the failure record the escalation was written against; the task did not define it. dispatch-loop.ts only returns escalations and never writes the file. So the repeated-tick test runs the cli-hierarchy escalation-file command repeatedly, which is the real caller of the writer. I did not add a test that runs dispatch-loop.ts itself. The patch-coverage gate passed at 100% on the new lines in escalation-file.ts. I also committed the task file's one-line status change, which was left unstaged in the worktree.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

