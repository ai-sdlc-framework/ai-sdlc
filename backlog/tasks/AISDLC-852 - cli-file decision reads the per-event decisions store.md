---
id: AISDLC-852
title: 'fix: cli-file decision reads and appends the per-event _decisions/events/ store, not only the legacy events.jsonl'
status: To Do
assignee: []
created_date: '2026-10-13'
labels: [bug, pipeline-cli, decisions]
dependencies:
  - AISDLC-719
references: [pipeline-cli/src/cli/file.ts, pipeline-cli/src/decisions/event-log.ts, pipeline-cli/src/cli/decisions.ts, docs/operations/decision-authority.md]
priority: high
dispatchable: true
---

## Description

**Five-step review (requirements first).** 1. Requirement questioned: that `cli-file decision` validates and files decision events through its own reader of `.ai-sdlc/_decisions/events.jsonl` (`EVENT_LOG_REL` in `pipeline-cli/src/cli/file.ts`), a requirement set when `cli-file` was written against the pre-AISDLC-719 single-file log. 2. Deleted: the private `events.jsonl` reader and appender inside `file.ts` is deleted; `cli-file` uses the shared event-log module in `pipeline-cli/src/decisions/event-log.ts`, which already reads the `events/` directory and the legacy file. 3. Simplified: one event-store implementation instead of two; the duplicate `(decisionId, type)` check runs over what the shared reader returns. 4. Accelerated: the planner can file a decision in a repository that was initialised after AISDLC-719 without a manual workaround, so the decision-record handoff is one command again. 5. Automated: a test fixture repository with only `events/` files exercises `cli-file decision` end to end in CI.

Observed on 2026-10-13 in the `ai-sdlc-io` repository: `cli-decisions add` writes `.ai-sdlc/_decisions/events/<...>.json` (per-event store, AISDLC-719) while `cli-file decision DEC-0001 --task-id IO-1 --answer <opt>` reads only `events.jsonl` and refuses with `no decision-opened event for DEC-0001 in .ai-sdlc/_decisions/events.jsonl`. The two commands the planner is told to use together cannot be used together in any repository that has no legacy log.

## Scope

1. `pipeline-cli/src/cli/file.ts`: replace the `EVENT_LOG_REL` read with the shared reader from `pipeline-cli/src/decisions/event-log.ts` (directory store plus legacy file), and write the `operator-answered` event through the shared appender so it lands in `events/` as one file.
2. The "events not already on origin/main" filter and the duplicate `(decisionId, type)` refusal operate on the merged event list; the files staged on the filing branch are the new `events/*.json` files (and `events.jsonl` only when the repository still uses it).
3. `cli-file rebase` handles the per-file store (no single-file conflict to resolve).
4. Tests in `pipeline-cli/src/cli/file.test.ts` (or the existing test file for `file.ts`): fixture with `events/` only, fixture with `events.jsonl` only, fixture with both; `--answer` on a per-event store; duplicate refusal across stores.
5. `docs/operations/decision-authority.md`: the filing example states that the store is `events/` and that `cli-decisions add` must be run (and committed) in the same checkout before `cli-file decision`.

Out of scope: `cli-decisions` itself; migrating legacy logs.

## Acceptance Criteria

- [ ] In a fresh fixture repo, `cli-decisions add ...` followed by `cli-file decision DEC-0001 --task-id X-1 --answer opt-a` succeeds and the filing branch contains one new file under `.ai-sdlc/_decisions/events/`.
- [ ] The same sequence in a fixture with a legacy `events.jsonl` still succeeds and appends to the legacy file only if the repo has no `events/` directory.
- [ ] A duplicate `(decisionId, operator-answered)` across the two stores is refused with the existing message.
- [ ] `pnpm test` in `pipeline-cli` passes with the new tests; coverage gate unaffected.
