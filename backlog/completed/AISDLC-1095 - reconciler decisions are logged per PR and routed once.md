---
id: AISDLC-1095
title: 'reconciler observability: the watch scheduler logs to the board, every PR row in pr-snapshot carries lane, action, reason, owner and lastActionAt, status prints the table, and the planner receives each new routing line once'
status: Done
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile-scheduler.ts
  - pipeline-cli/src/hierarchy/scheduler.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/cli/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28. The `reconcile --watch` scheduler started by `cli-hierarchy up` has stdout and stderr on `/dev/null` (checked with `lsof` on pid 67056), so forty-eight minutes of reconciling left no record of what it decided. `.ai-sdlc/dispatch/pr-snapshot.json` lists the 15 open PRs with their merge state only: no lane, action, reason or owner, so "why is #1663 still open" cannot be answered from the board. On the other side the dispatch module forwards the whole reconcile stdout to the planner whenever it contains the substring `route-to-planner` (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`), which bypasses the `routeOnce` dedupe and repeats every stored record each tick. Dispatch state that matters is also kept in prose files (`pending-resumes.md`, `pending-arm.md`, `rerun-plan.md`) whose newest entries date from 2026-10-15 and 2026-10-17; nothing reads them.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the scheduler is a background helper, its output does not matter": a reconciler that decides the fate of every PR is the control loop, and a control loop with no log is unverifiable; the real requirement is "every decision about a PR is one readable row with a reason". Deleted: the three prose state files (their open items are re-expressed as board records or dropped with a note in the task PR), and the stdout-substring forwarding. Simplified: one row shape shared by the scheduler log, `pr-snapshot.json`, `cli-hierarchy status` and the planner routing. Accelerated: the operator answers "why is this PR open" from one status line. Automated: a routing line is sent once per `(pr, head, action)` by `routeOnce`, on both the host and the scheduler path.

1. `reconcile-scheduler.ts` / `scheduler.ts`: stdout and stderr go to `.ai-sdlc/dispatch/log/reconcile.log` (append, 5 MB rotate); each run writes one JSON line per PR: `{at, pr, head, lane, state, action, reason, owner, lastActionAt, attempts}`.
2. `pr-snapshot.ts`: the per-PR entry gains the same fields; `cli-hierarchy status` prints `PRs: n open` and a table sorted by age with those columns; `--json` includes them.
3. `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`: replace the substring forward with `routeOnce` over the structured rows; one `SendMessage` line per new `(pr, head, action)`.
4. `cli/dispatch.ts`: `reconcile` prints the structured rows; the free-text report moves behind `--verbose`.
5. Delete `pending-resumes.md`, `pending-arm.md`, `rerun-plan.md`, `pending-676.md` from the board template and the dispatch command prose; the task PR lists any item from them that is still live and where it now lives.
6. Tests: scheduler log line shape; status table; routeOnce on the host path (same row twice sends once).
7. `docs/operations/cli-hierarchy.md`: the row shape and the log path.

## Acceptance Criteria

- [x] After `cli-hierarchy up`, `.ai-sdlc/dispatch/log/reconcile.log` receives one row per open PR per run.
- [x] `cli-hierarchy status` prints every open PR with lane, action, reason, owner and age.
- [x] A reconcile run repeated with unchanged facts sends the planner nothing; a new routing sends exactly one line.
- [x] The four prose state files are gone from the board and from every command prose that named them.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Added ai-sdlc-plugin/hooks/dispatch-routing.test.mjs (node --test, 6 cases) to cover newRoutingLines and the dispatch tick's planner-once behaviour. This answers the round-1 test-reviewer finding.

## Changes
- ai-sdlc-plugin/hooks/dispatch-routing.test.mjs

## Design decisions
I ran `pnpm build && pnpm test && pnpm lint && pnpm format:check` with AI_SDLC_EXECUTOR_TASK, AI_SDLC_HIERARCHY_ROLE and AI_SDLC_HIERARCHY_SESSION unset, and all four exited clean. Only the tail of the `pnpm test` output was captured, so I have no summary line to quote, and I did not run coverage. The new file's own run reported 6 pass, 0 fail. The test file covers these cases: empty and non-JSON stdout, acted with and without a note, a routed entry, an unrelated action, and a leading log line before the JSON. Two tick tests check that the planner gets no message when route-to-planner appears only in prose, and exactly one line for a new routing. The branch was already up to date with origin/main, so the rebase changed nothing. The first two push attempts were blocked by the governance hook, which rejected the `cd && git push` chain and a push from the parent cwd. The push succeeded as `git -C <worktree> push --force-with-lease -u origin HEAD:refs/heads/<branch>`. PR #2132 already existed, so I did not open a new one.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

