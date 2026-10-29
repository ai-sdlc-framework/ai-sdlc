---
id: AISDLC-1117
title: ephemeral spawn refuses every eligible claim while an orphaned tmux session carries the executor name; the tick must reap orphans and surface spawn errors
status: In Progress
assignee: []
created_date: '2026-10-29'
labels:
  - hierarchy
  - dispatch
  - velocity
priority: high
references:
  - pipeline-cli/src/hierarchy/spawn.ts
  - pipeline-cli/src/hierarchy/ephemeral-tick.ts
  - pipeline-cli/src/hierarchy/down.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
---

## Description

On 2026-10-29 after the last standing executors were brought down (23:40Z), the board sat at 12 queued, 0 inflight with four eligible claims and no executor ever appeared. `cli-hierarchy status` showed only planner and dispatch; the tick ran every minute. `cli-hierarchy spawn AISDLC-785` by hand printed `tmux session 'ai-sdlc-executor-aisdlc-785' exists but is not in the roster; refusing to start a duplicate`. `tmux ls` held 54 sessions named `ai-sdlc-executor-aisdlc-*`, all created 2026-10-28 (before the 2026-10-29 relaunch), none in `hierarchy.json`, each holding an idle `claude` at 7-8% context. Every eligible task (940, 461, 737, 785, 655.2, 655.3, 1077) had such a session, so the ephemeral tick's `spawnForEligibleClaims` failed on each and the drain stalled silently. Killing the 54 sessions by hand fixed it at once.

Two defects. (1) A tmux session whose name matches a spawned-executor name but which is absent from the roster and holds no inflight task is an orphan, not a duplicate: `spawn` must reclaim it (kill, then create) instead of refusing, and the tick's sweep should reap such orphans on its own. The orphans came from the 2026-10-28 sessions surviving a roster rewrite (`down` of the whole hierarchy and `up` only touch roster entries), so the ephemeral down-on-verdict path must also be checked to confirm it kills the tmux session and not only the roster entry. (2) The spawn errors were invisible: `status` printed nothing, the only trace was a `TICK` escalation file saying `cli-hierarchy tick did not return a result`. A tick with `spawnErrors` must print them in `status` (one line per task, same place as `dynamic executor:`) and the drain-stall check (AISDLC-1101) must count a non-empty `spawnErrors` with an empty roster as a stall.

**Five-step review (requirements first).** Requirement questioned: is a same-named tmux session outside the roster ever a legitimate reason to refuse? No: the roster is the authority (RFC-0051); a session the roster does not know is an orphan. Deletion: the refusal branch for an unrostered session goes; the refusal for a rostered live session stays. Simplified: one orphan rule used by both `spawn` and the sweep. Accelerated: a drain resumes on the next tick instead of waiting for a human to notice an empty roster. Automated: the sweep reaps, `status` reports, the stall check fires.

## Fix

1. `spawn.ts`: when the tmux session exists and the roster has no entry for it, kill the session, log `reclaimed orphan <name>`, and continue with the normal create path. Keep the refusal when the roster lists the name.
2. `ephemeral-tick.ts` sweep step: list tmux sessions matching the spawned-executor pattern, kill those not in the roster, report them in the tick result (`reaped: [name]`).
3. Verify the down-on-verdict path kills the tmux session (not only the roster entry); add a test asserting the session is gone after a verdict down.
4. `status`: print `spawn error: <task> <reason>` lines from the last tick result; the drain-stall check treats spawn errors with zero live executors as a stall.
5. Runbook: a short "orphaned executor sessions" entry in `docs/operations/cli-hierarchy.md`.

## Acceptance Criteria

- [ ] AC1: with a tmux session `ai-sdlc-executor-aisdlc-999` present and no roster entry, `cli-hierarchy spawn AISDLC-999` kills it and spawns (unit test with a fake tmux).
- [ ] AC2: with the same session present and a roster entry for it, `spawn` still refuses.
- [ ] AC3: the tick sweep reaps an unrostered spawned-executor session and lists it in the tick result.
- [ ] AC4: after a verdict down, the executor's tmux session no longer exists (test).
- [ ] AC5: `status` prints each spawn error of the last tick; the drain-stall check fires on spawn errors with zero live executors.
- [ ] AC6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Out of scope

The executor cap and budget pacer (AISDLC-1076); VS Code terminal visibility of dynamic executors (the vscode-hierarchy extension covers it).
