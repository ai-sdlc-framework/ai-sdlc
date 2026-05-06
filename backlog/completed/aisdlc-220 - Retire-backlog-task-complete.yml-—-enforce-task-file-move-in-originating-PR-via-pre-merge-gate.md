---
id: AISDLC-220
title: >-
  Retire backlog-task-complete.yml — enforce task file move in originating PR
  via pre-merge gate
status: Done
assignee: []
created_date: '2026-05-06 17:19'
labels:
  - enhancement
  - ci
  - backlog-workflow
  - framework-bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`.github/workflows/backlog-task-complete.yml` opens a separate `chore: close AISDLC-N (auto)` PR after every code PR merges, to move the task file from `tasks/` to `completed/`. This is the wrong shape:

1. **Splits a single logical change across two PRs** — the work + the lifecycle close should be one atomic commit. Looking at the diff, "did this task ship?" requires correlating two PRs.
2. **Creates orphan PRs that don't auto-merge** (per AISDLC-219 — GITHUB_TOKEN-pushed PRs don't fire CI or trigger auto-enable-auto-merge). 4 stuck examples observed 2026-05-06: #360, #362, #367, #368.
3. **Idempotency check is unreliable** — the workflow's "skip if already closed" path (`scripts/close-backlog-task.sh exits 2`) only fires when the task file is already in `completed/` at merge time. If the dev subagent forgot the move, the workflow opens the chore PR. Then operator has to babysit a separate PR.
4. **Operator preference**: tasks should close in the PR that ships them. No separate chore noise. Diff = work + lifecycle = atomic.

## Design (operator preference, 2026-05-06)

**Mirror the attestation auto-sign pattern: a pre-push hook auto-moves the task file if missing, so the PR's own diff carries the lifecycle close. No separate workflow, no operator gate, no PR rejection — just an automatic helping hand at push time, same shape as `scripts/check-attestation-sign.sh`.**

1. **New pre-push hook** `scripts/check-task-moved.sh` (sibling of `scripts/check-attestation-sign.sh`):
   - Detect: if any commit in the push range has subject containing `(AISDLC-N)`, AND `backlog/tasks/aisdlc-N - *.md` exists locally, AND `backlog/completed/aisdlc-N - *.md` does NOT exist
   - Action: invoke the AISDLC-203 atomic helper (`node pipeline-cli/bin/cli-task-complete.mjs AISDLC-N`) which moves the file + sets `status: Done`
   - Stage the moved file + create a `chore: auto-close AISDLC-N` commit (same pattern as the attestation chore commit)
   - Exit 1 with "re-run git push" so the new commit goes up on the next push (idempotent: second push detects the move is already on HEAD and no-ops)
   - Skip env: `AI_SDLC_SKIP_TASK_MOVE=1` (mirrors the existing skip envs)
2. **Wire into `.husky/pre-push`** chain after the coverage gate, **BEFORE** the attestation-sign gate. **Order is load-bearing — DO NOT swap.** The attestation envelope's `contentHashV4` field binds `{path, headBlobSha}` for every changed file. If the task move happens AFTER attestation sign, the envelope hashes the OLD file path (`backlog/tasks/aisdlc-N - *.md`) but the actual PR diff contains the NEW path (`backlog/completed/aisdlc-N - *.md`) — `verify-attestation` will reject the envelope because the file map doesn't match. Order in `.husky/pre-push`: `check-coverage.sh` → **`check-task-moved.sh`** → `check-attestation-sign.sh`.
3. **`/ai-sdlc execute` slash command body**: already does the move (per CLAUDE.md "task file is moved to backlog/completed/ BEFORE push"). The new hook becomes a safety net for paths that forgot — including ad-hoc `gh pr create` PRs and external contributors.
4. **External contributor path**: when they push a branch with `(AISDLC-N)` in any commit subject and the file is still in `tasks/`, the hook automatically moves it. They get a clear message: `[task-move] auto-closing AISDLC-N — re-run git push to send the move commit`. Zero friction, zero learning curve.
5. **Retire `backlog-task-complete.yml`**: delete the workflow file. No more auto-PR creation. No more orphan chore PRs. The pre-push hook handles every dispatch path uniformly.
6. **Backfill cleanup**: 4 stuck chore: close PRs (#360, #362, #367, #368) need operator triage:
   - If file is already on main in completed/ → close PR as superseded
   - If file is genuinely missing → manually move + commit + push (the new hook will handle this on push)
7. **Hermetic test** at `scripts/check-task-moved.test.mjs`: same harness pattern as `check-attestation-sign.test.mjs` — set up a fixture repo with a task file in `tasks/`, simulate a push with `(AISDLC-N)` in the commit subject, assert the hook moved the file + created the chore commit + exited 1 with the "re-run" message.

## Composes with / supersedes

- **Supersedes AISDLC-219** (PAT-switch band-aid for the orphan PRs). After this lands, the workflow that AISDLC-219 fixes goes away entirely. Withdraw AISDLC-219 as part of this task.
- **Composes with AISDLC-218** (draft-PR flow): the dev subagent already moves the task file in the work commit; this gate enforces it across all paths.
- **Composes with AISDLC-203** (atomic Codex completion): the helper `completeTaskAtomically()` is the canonical way to do the move; the gate verifies it ran.

## Acceptance Criteria

- [ ] #1 New `scripts/check-task-moved.sh` pre-push hook detects `(AISDLC-N)` in any commit subject in the push range, invokes `cli-task-complete` if file is still in `tasks/`, commits the move as `chore: auto-close AISDLC-N`, exits 1 with "re-run git push" (mirrors `check-attestation-sign.sh` shape)
- [ ] #2 Wired into `.husky/pre-push` chain AFTER coverage gate, **BEFORE** attestation-sign gate. Order is load-bearing — attestation's contentHashV4 binds {path, headBlobSha} per file; if the move happens AFTER sign, the envelope hashes the old path while the PR diff contains the new path → verify-attestation rejects. Hermetic test asserts the chain order at `scripts/check-task-moved.test.mjs`.
- [ ] #3 Skip env `AI_SDLC_SKIP_TASK_MOVE=1` honored
- [ ] #4 Idempotent: second push (after the chore commit) detects the move already on HEAD and no-ops
- [ ] #5 Hermetic test at `scripts/check-task-moved.test.mjs`: fixture repo with task file in `tasks/` + `(AISDLC-N)` in commit subject → hook moves file + creates chore commit + exits 1
- [ ] #6 Hermetic test: same setup but with `AI_SDLC_SKIP_TASK_MOVE=1` → hook is a no-op
- [ ] #7 `backlog-task-complete.yml` deleted (workflow file removed)
- [ ] #8 `scripts/close-backlog-task.sh` deleted if not referenced elsewhere
- [ ] #9 Backfill: 4 stuck chore: close PRs (#360, #362, #367, #368) triaged manually (operator action — close superseded ones, finish the rest)
- [ ] #10 CLAUDE.md `## Hooks` section adds the new hook entry; `## Backlog Workflow` section removes references to `backlog-task-complete.yml`
- [ ] #11 AISDLC-219 marked Withdrawn (registry note: superseded by AISDLC-220)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary

Retired `.github/workflows/backlog-task-complete.yml` and `scripts/close-backlog-task.sh` (both deleted by orchestrator pre-work). Added `scripts/check-task-moved.sh` — a pre-push hook that detects `(AISDLC-N)` in commit subjects, invokes the AISDLC-203 `cli-task-complete` atomic helper to move the task file from `backlog/tasks/` to `backlog/completed/`, commits the move as a chore commit, and exits 1 with "re-run git push". The hook is wired into `.husky/pre-push` AFTER the coverage gate and BEFORE the attestation-sign gate (order is load-bearing per AC #2 — contentHashV4 binds {path, headBlobSha}). All 9 hermetic tests pass.

## Changes

- `scripts/check-task-moved.sh` (new): pre-push hook mirroring check-attestation-sign.sh structure
- `scripts/check-task-moved.test.mjs` (new): 9 hermetic tests covering all ACs (a)-(g)
- `.husky/pre-push` (modified): inserts check-task-moved.sh at position 2 with load-bearing order comment
- `package.json` (modified): adds `test:task-move-gate` script and wires into `test` aggregator
- `CLAUDE.md` (modified): Hooks section adds item 2, Done semantics updated to remove workflow reference
- `docs/operations/operator-runbook.md` (modified): rewrites Backlog-task auto-close section
- `ai-sdlc-plugin/commands/execute.md` (modified): updates footer reference from workflow to hook
- `.github/workflows/backlog-task-complete.yml` (deleted, pre-staged by orchestrator)
- `scripts/close-backlog-task.sh` (deleted, pre-staged by orchestrator)
- `.ai-sdlc/pipeline-backlog.yaml` (modified, pre-staged by orchestrator)

## Design decisions

- **Mirror attestation-sign pattern**: same exit-1 + re-push pattern means operators already know the workflow from AISDLC-133; no new mental model required.
- **Order before attestation-sign**: contentHashV4 binds {path, headBlobSha} per file; move must happen before sign or verify-attestation rejects the envelope.
- **Single chore commit for multiple moves**: when multiple task IDs appear in a push range, one chore commit covers all moves rather than N separate commits, keeping history clean.
- **AI_SDLC_TASK_COMPLETE_CMD override**: allows tests to stub cli-task-complete without a pipeline-cli build (mirrors AI_SDLC_SIGN_ATTESTATION_CMD in attestation hook).

## Verification

- `pnpm build` — clean
- `pnpm test:task-move-gate` — 9 tests, all pass
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up

- AISDLC-219 marked Withdrawn (superseded by this task) — operator action
- 4 stuck chore PRs (#360, #362, #367, #368) need manual triage — operator action
