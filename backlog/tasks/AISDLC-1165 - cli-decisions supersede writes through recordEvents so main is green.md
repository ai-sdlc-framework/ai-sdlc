---
id: AISDLC-1165
title: 'cli-decisions supersede writes its event through recordEvents; main is red on decisions-write-root.test.ts and every pre-push fails'
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - pipeline-cli
  - decisions
  - main-red
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/src/cli/decisions-write-root.test.ts
priority: high
dispatchable: true
---

## Description

Main is red. AISDLC-1161 (#2303) added the invariant test `recordEvents is the only direct appendDecisionEvent caller` in `pipeline-cli/src/cli/decisions-write-root.test.ts`. AISDLC-1162 (#2304) landed separately and its new `supersede` command calls `appendDecisionEvent(evt, { workDir })` directly (`pipeline-cli/src/cli/decisions.ts`, the supersede handler, about line 2171). Each PR was green alone; together the test finds two calls and fails.

The pre-push hook runs the pipeline-cli tests, so every code push in the repo is refused until this is fixed. Rebases of #2308 (AISDLC-1156) and #2271 (AISDLC-1087) are done locally and waiting on it.

**Five-step review (requirements first).**
1. Requirement questioned: the single write path from AISDLC-1161 stays; supersede must honour it like every other command.
2. Delete: the direct `appendDecisionEvent` call in supersede.
3. Simplify: call `recordEvents(argv, workDir, id, [evt])`, as the other commands do. This also gives supersede the `--file` routing for free.
4. Accelerate: unblocks every pending push.
5. Automate: the existing invariant test is the guard.

## Acceptance Criteria

- [ ] AC-1: The supersede handler writes its event through `recordEvents`; `decisions.ts` contains exactly one `appendDecisionEvent(` call, inside `recordEvents`.
- [ ] AC-2: `decisions-write-root.test.ts` passes and the existing supersede tests still pass; add one test that `supersede --file` routes through `cli-file` like `answer --file`.

## Notes

Semantic collision between two sibling PRs that landed on 2026-11-03. Found by the planner's rebase agents for #2308 and #2271.
