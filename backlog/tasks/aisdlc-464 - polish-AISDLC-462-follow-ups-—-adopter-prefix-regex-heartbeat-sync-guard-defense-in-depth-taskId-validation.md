---
id: AISDLC-464
title: >-
  polish: AISDLC-462 follow-ups — adopter-prefix regex, heartbeat sync guard,
  defense-in-depth taskId validation
status: To Do
assignee: []
created_date: '2026-05-28 20:23'
labels:
  - polish
  - follow-up
  - execute-parallel
  - adopter-readiness
dependencies:
  - AISDLC-462
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three minor reviewer findings on the AISDLC-462 iter-2 review that were APPROVED with advisory notes. Tracked here for follow-up rather than blocking merge.

## Findings (all non-blocking; APPROVED ship)

### 1. TMUX_WINDOW_RE too narrow for non-AISDLC adopters

`ai-sdlc-plugin/commands/execute-parallel-cleanup.md` — `TMUX_WINDOW_RE = /^exec-aisdlc-[a-z0-9.-]+$/` only matches windows prefixed `exec-aisdlc-`. The spawn side builds `exec-${TASK_ID_LOWER}` for any validated task ID, so adopters using `PROJ-123`, `INGEST-7`, etc., would have windows named `exec-proj-123` which the cleanup regex rejects → logged as security error and not killed → orphan windows accumulate.

**Fix:** broaden to `/^exec-[a-z][a-z0-9]+-[0-9][a-z0-9.-]*$/` matching any validated-task-ID-derived window name. Also tighten the schema-side `taskId` pattern (`spec/schemas/dispatch-session.v1.schema.json:25`) to match `validate_task_id` regex.

### 2. heartbeat.test.mjs manual-sync drift risk

`ai-sdlc-plugin/scripts/heartbeat.test.mjs:29` — `UPDATE_SESSION_STATE_FUNC` is a copy of the `update_session_state` function body from `ai-sdlc-plugin/commands/execute.md:326-345`. Function bodies match today but there's no automated drift guard.

**Fix:** extract function body to a standalone shell-include file (e.g. `ai-sdlc-plugin/scripts/lib/update-session-state.sh`), source it from execute.md AND heartbeat.test.mjs.

### 3. Cleanup `s.taskId` not validated for path traversal

`ai-sdlc-plugin/commands/execute-parallel-cleanup.md:120` — `s.taskId` flows into `path.join(sessionsDir, s.taskId.toLowerCase() + '.session.json')` without validation. Local write access required to exploit; trivial defense-in-depth fix.

**Fix:** apply the same `validate_task_id` regex to `s.taskId` before any path construction.

## Why these are follow-ups, not iter-3 of AISDLC-462

All three are MINOR severity per reviewers — APPROVED ship. Per `feedback_act_on_reviewer_findings`: minor/suggestion get filed as backlog tasks or inline-fixed if trivial.

## References

- AISDLC-462 — parent feature (PR #764)
- iter-2 verdict files: `.worktrees/aisdlc-462/.ai-sdlc/verdicts/{code,test,security}-reviewer-aisdlc-462.json`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 TMUX_WINDOW_RE in execute-parallel-cleanup.md broadened to match any validated-task-ID-derived window name; schema taskId pattern tightened to match validate_task_id regex (no drift between schema + shell)
- [ ] #2 update_session_state function body extracted to ai-sdlc-plugin/scripts/lib/update-session-state.sh; sourced from execute.md and heartbeat.test.mjs; manual copy in test removed
- [ ] #3 Cleanup s.taskId validated with same regex pattern as tmuxWindow before path construction; defense-in-depth test added that confirms attempted .. traversal in session-file taskId is rejected
<!-- AC:END -->
