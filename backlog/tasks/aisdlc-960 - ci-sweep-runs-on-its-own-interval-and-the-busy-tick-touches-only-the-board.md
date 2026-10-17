---
id: AISDLC-960
title: 'The CI sweep runs on its own 15-minute interval and the 30-second busy tick touches only the board'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - cost
dependencies: []
references:
  - pipeline-cli/src/cli/ci.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

Every dispatch tick runs `cli-ci sweep`, which lists queued workflow runs (`gh run list --status queued --limit 500`, up to five pages) and open PRs, then cancels stale runs. At the busy cadence of one tick per 30 seconds that is up to 600 calls per hour for a check whose answer rarely changes within a minute. The tick itself also makes its GitHub reads at that cadence, although the only thing that changes every 30 seconds is the local board.

**Five-step review (requirements first).**
1. Requirement questioned: does stale-run cancellation need to run per tick? No; a stale run costs runner minutes, not correctness, and 15 minutes of staleness is acceptable.
2. Delete: the sweep call from the tick body.
3. Simplify: the sweep runs on its own timer (15 minutes, recorded on the board) and the busy 30-second tick claims, clears and reissues from the board without any GitHub call; GitHub reads happen on the 5-minute cadence or on a webhook wake.
4. Accelerate: the sweep lists runs with `--limit 100` and stops paging once it reaches runs older than the oldest open PR head.
5. Automate: a test asserts a busy tick makes zero GitHub calls and the sweep runs at most once per 15 minutes.

## Acceptance Criteria

- [ ] A 30-second busy tick makes no GitHub call.
- [ ] `cli-ci sweep` runs at most once per 15 minutes per board.
- [ ] The dispatch command body and `docs/operations/cli-hierarchy.md` describe the two cadences.
