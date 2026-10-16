---
id: AISDLC-904
title: 'feat: cli-dispatch reprioritize moves a queued task to the front and the claim order is documented'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [dispatch, velocity]
references: [pipeline-cli/src/dispatch/board.ts, pipeline-cli/src/cli/dispatch.ts, pipeline-cli/src/dispatch/resume.ts, docs/operations/cli-hierarchy.md]
priority: medium
dispatchable: true
---

## Description

On 2026-10-15 main was red and the fix task sat in `queue/` at priority 1 for about two hours while three executors claimed and failed older priority-1 tasks that could not pass until the fix landed. `claimNext` in `pipeline-cli/src/dispatch/board.ts` orders eligible manifests by wave, then priority (any finite number, ascending, absent last), then file mtime, so within one priority band the order is first-in-first-out and a late critical task waits behind everything filed before it. Nothing in the CLI changes a queued task's priority after `enqueue --priority`, and nothing documents the order; dispatch guessed "resume manifests sort ahead" and the planner had to read the source and tell dispatch to hand-edit the JSON to `"priority": 0`. Hand-editing board files is prohibited for every other field.

The same gap applies to a queued manifest's `resume.note`: `write-manifest` refuses an existing queue file, so the only way to attach a fresh instruction to a queued task is the same hand edit.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that priority is fixed at enqueue time. Priority is an operational signal about the queue, and the queue changes (main goes red, a dependency lands); the signal must be re-settable while the task is still unclaimed. 2. Deleted: the undocumented folk rule "resume manifests go first" (it was never true) and the hand-edit workaround. 3. Simplified: one command, `cli-dispatch reprioritize <task-id> --priority <n> [--note "<text>"]`, that rewrites exactly `priority` (and optionally `resume.note`, through the same validation `resume.ts` applies) on a `queue/` manifest and refuses on any other location; no new sort key, no "urgent" flag: priority 0 already beats 1 under the existing comparator. 4. Accelerated: dispatch moves a critical fix to the front in one command during the tick, without a planner turn. 5. Automated: `cli-dispatch peek --order` prints the eligible queue in exact claim order with the three keys, so the next "why is this not first" is answered by the CLI, and `docs/operations/cli-hierarchy.md` states the order in one sentence.

## Acceptance Criteria

- [ ] `cli-dispatch reprioritize <task-id> --priority <n>` rewrites only `priority` on `queue/<task-id>.dispatch.json`, leaves every other field byte-identical, and refuses with a clear message when the task is in `inflight/`, `done/` or `failed/`. Tests cover success and each refusal.
- [ ] `--note "<text>"` on the same command sets `resume.note` under the existing `MAX_NOTE_CHARS` validation in `pipeline-cli/src/dispatch/resume.ts`; a note over the limit is refused.
- [ ] `cli-dispatch peek --order` lists eligible queue entries in the order `claimNext` would claim them, showing `wave`, `priority` and `dispatchedAt`; the test asserts the printed order equals the claim order on a mixed board.
- [ ] `docs/operations/cli-hierarchy.md` documents the claim order (wave, priority ascending with absent last, then enqueue time) and the `reprioritize` command.
- [ ] Task file moved to `backlog/completed/` in the PR.
