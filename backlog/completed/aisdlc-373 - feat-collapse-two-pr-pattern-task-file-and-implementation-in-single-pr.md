---
id: AISDLC-373
title: 'feat(orchestrator): collapse 2-PR pattern — task file + implementation land in single PR'
status: Done
assignee: []
created_date: '2026-05-19'
labels:
  - orchestrator
  - throughput
  - workflow
  - critical
dependencies: []
priority: critical
references:
  - pipeline-cli/bin/cli-orchestrator.mjs
  - docs/operations/operator-runbook.md
---

## Problem

Today's task-to-merge flow needs **two PRs** for every new piece of work:

1. **PR A — task file**: agent/operator commits the task body (`backlog/tasks/<id>.md`) and opens a PR. Waits for DoR clarifications, CI, queue (~15-30min)
2. **PR B — implementation**: only once PR A is on main does the orchestrator dispatch a developer subagent that creates a worktree, implements, opens PR B

This costs ~15-30min of wall-clock waiting between PR A merging and PR B's first commit, on top of the actual dev time. For operator-driven work where the operator already knows exactly what they want built, this round trip is pure overhead.

The 2-PR pattern was designed around three assumptions:

1. **Frontier visibility**: `cli-deps frontier` reads `backlog/tasks/` on main → worktree-local tasks are invisible to the autonomous orchestrator
2. **DoR ingress runs on main-state**: the workflow scans main-branch task files, not PR-diff additions
3. **Plan-before-code checkpoint**: separating task creation from implementation forces a review gate on "is this the right thing to build"

None of these justify the 2-PR cost for **operator-driven** work:

1. The frontier exists for the autonomous orchestrator to pick the next task. When the operator manually triggers a task, no frontier consultation is needed — they already picked it.
2. DoR can run on the PR diff just as well as on main state. Same engine, different file set.
3. The plan-before-code checkpoint is theater for most internal work — by the time the operator is typing the task body, they already know the implementation shape.

## Single-PR flow (proposed)

```
1. Agent/operator creates task file in a worktree (under `.worktrees/<task-id>/backlog/tasks/`)
2. Agent implements alongside
3. Commits: feat + task-file-add (or interleaved)
4. Pre-push DoR gate (AISDLC-370) validates the task file locally
5. Push → CI's "Evaluate backlog tasks changed by PR" picks up the NEW task file
   in the diff and DoR-checks it
6. PR merges atomically: task file lands in backlog/completed/ + implementation
   lands in the same commit
```

Existing tooling already supports most of this:

- ✅ `scripts/check-task-moved.sh` auto-moves task to `completed/` in the same PR (AISDLC-220)
- ✅ `mcp__plugin_ai-sdlc_ai-sdlc__task_create` routes to active worktree under Pattern C (AISDLC-216)
- ✅ `verify-attestation` + `ai-sdlc-review` operate on PR diff, not main state
- ✅ AISDLC-370 (in-flight) adds pre-push DoR gate

What needs to change:

## Fix (single PR)

### A. `cli-orchestrator tick`: accept worktree-local task files

Add a `--task-from-file <path>` (or `--task <id>` with optional worktree-local resolution) mode that bypasses the frontier consultation and dispatches against a task file the operator already created in a worktree.

Flow:

```bash
# Operator creates a task file locally
mkdir -p .worktrees/aisdlc-380/backlog/tasks
$EDITOR .worktrees/aisdlc-380/backlog/tasks/aisdlc-380*.md

# Dispatch against the local task — no main-state requirement
cli-orchestrator tick --task-from-file .worktrees/aisdlc-380/backlog/tasks/aisdlc-380*.md
```

The dispatched developer subagent works in the same `.worktrees/aisdlc-380/`, picks up the task file already there, and commits BOTH the task file + implementation in one push.

### B. DoR ingress workflow: scan PR-diff additions

Update the DoR ingress workflow (under `.github/workflows/`) to also check task files newly added in the PR diff, not just main-state task files. Same `checkUpstreamOqs()` / `refineBacklogTask()` engine; different file-list source:

```bash
# On pull_request events, scan BOTH the diff additions AND main state
git diff --name-only --diff-filter=A origin/main...HEAD -- 'backlog/tasks/**.md'
```

Run DoR against any task file newly added in the PR. If clean, post DoR-clean comment. If violations, post the same clarifications comment used today.

### C. Document the new flow as preferred

Update `docs/operations/operator-runbook.md` + `CLAUDE.md`:

- The single-PR flow is the preferred operator-driven path
- The 2-PR pattern is still valid for autonomous-orchestrator dispatches (frontier consultation needed)
- `/ai-sdlc execute <task-id>` already follows this in spirit (creates worktree first, commits task + impl together) — document that as the canonical example

### D. Frontier-aware orchestrator stays the way it is

The autonomous orchestrator tick still consults the frontier (on main) to decide what to pick up next. That hasn't changed. The new `--task-from-file` mode is additive — for the manually-triggered path.

## Acceptance criteria

- [x] `cli-orchestrator tick --task-from-file <path>` (or equivalent `--task <id>` with worktree resolution) dispatches a developer subagent against a worktree-local task file
- [x] The dispatched developer commits BOTH the task file move (tasks/ → completed/) AND the implementation in the same PR
- [x] DoR ingress workflow checks PR-diff `backlog/tasks/**.md` additions, runs `checkUpstreamOqs()` + the seven-point rubric, posts the same clarifications comment as today's main-state path (already shipped — the existing `.github/workflows/dor-ingress.yml` `evaluate-pr-tasks` job uses `git diff --diff-filter=AM` against `backlog/tasks/*.md`; the workflow predated AISDLC-373 and is unchanged in this PR. If the operator wants `backlog/completed/*.md` additions covered too, that is a follow-up workflow change tracked separately — `.github/workflows/**` is out of scope for dev subagents)
- [x] `docs/operations/operator-runbook.md` documents the single-PR flow as preferred for operator-driven work; the 2-PR pattern remains documented for autonomous orchestrator dispatches
- [x] `CLAUDE.md`'s "Canonical execution paths" table updated with the new pattern
- [x] Integration test: simulate a worktree-local task file, dispatch via `--task-from-file`, verify the dispatched task id matches the resolved file (`pipeline-cli/src/cli/orchestrator.test.ts` AISDLC-373 suite — 4 tests)
- [x] New code reaches 80%+ patch coverage (13 unit tests in `task-from-file.test.ts` cover every helper branch; 4 CLI integration tests cover the wiring)

## Out of scope

- Removing the 2-PR pattern entirely (autonomous orchestrator still needs frontier on main)
- Reworking the admission-filter chain (DependencyReadiness etc. remains main-state for frontier picks)
- A new UI/TUI surface for the single-PR flow (CLI is sufficient)

## Source

Operator question 2026-05-19: "Why do we have to have a flow of create a backlog task, open a PR for it, then wait for it to land, then develop the task? Why can't we just create a task on a worktree then trigger the cli-orchestrator tick on that backlog issue and submit a PR for both the issue and the implementation in one PR?" — answered: we can; today's 2-PR pattern is a self-imposed constraint from the autonomous-orchestrator's main-state frontier dependency. This task collapses it for the operator-driven path.
