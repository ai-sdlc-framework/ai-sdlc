---
id: AISDLC-242
title: >-
  Resume from interrupted orchestrator runs — don't lose mid-flight dev work
status: Done
assignee: []
created_date: '2026-05-08 00:50'
labels:
  - enhancement
  - orchestrator
  - rfc-0015
  - resilience
  - dogfood
dependencies: []
priority: high
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When a `cli-orchestrator tick` dispatch is interrupted (operator kills the process, network blip, watchdog timeout, OOM, manual `pkill claude`, system shutdown), all of the dev subagent's mid-flight work is LOST:

- The worktree is auto-cleaned via AISDLC-177 rollback path
- The `claude --print` subprocess's conversation transcript is gone
- Any uncommitted file edits are gone
- Even committed-but-not-pushed work is gone if the worktree is removed

On retry, the orchestrator starts a fresh dispatch from scratch. The dev re-derives all the same work, costing 15-25 min of subscription time per redo.

Witnessed empirically 2026-05-07 multiple times:
- AISDLC-178.4.1 worktree quarantined mid-flight by Step 3 self-heal → had to recover from quarantine ref + re-run reviewers
- Operator killed runaway 178.7 dispatch (would have failed coverage gate anyway) → 12s of dev work lost (small, but principle holds)
- Background tick processes that never completed → next dispatch re-ran from zero

## Why this matters

Operator (2026-05-08): "we should have the ability to recover from interrupted orchistrator runs so we don't loose the work we were doing, if an agent is interrupted could they resume from where they left off?"

For long-running Tier 2 tasks (12+ ACs, 30+ files), losing 25 min of dev work is expensive. With autonomous overnight dispatch (RFC-0015 vision), random interruptions become more likely (network blip, system reboot, watchdog), so resume-from-interruption is foundational.

## Proposed mechanisms

### Mechanism 1 — Periodic auto-commit during dev work

Today the dev runs in a single subprocess; if killed mid-edit, the working tree state is lost. Have the dev (or the spawner wrapper) periodically `git add -A && git commit --no-verify -m "wip(checkpoint): ..."` every N minutes or every M file edits. On resume, the worktree has the dev's last checkpoint as its HEAD; new dev sees the partial work in git log + can either continue OR squash + restart.

Tradeoff: lots of WIP commits in branch history that need to be squashed before push. Cleanest with a `git rebase -i` autosquash convention.

### Mechanism 2 — Conversation transcript persistence

`claude --print` already supports `--session-id <id>` for resuming a prior conversation. The orchestrator could:
- Generate a stable session ID per dispatch (e.g. `<task-id>-<dispatch-attempt-N>`)
- Pass `--session-id` to `claude --print`
- On retry, pass the SAME session ID + a continuation prompt ("you were working on X, continue from where you left off")
- Claude Code resumes the prior session's context (transcript, file knowledge)

Tradeoff: depends on Claude Code's session-id semantics being stable across CLI invocations. Need to verify.

### Mechanism 3 — State snapshot file

After each significant tool use (Edit, Write), the dev writes to a `$WORKTREE/.ai-sdlc/dev-state.json` with: which AC is in progress, which files have been edited, latest test results. On resume, dev reads this state + continues. Lighter than periodic commits, less context-rich than conversation transcript.

### Mechanism 4 — Don't auto-cleanup on interruption

Today's rollback path removes the worktree on abort. If we KEEP the worktree on abort (with a status indicator like `aborted-recoverable`), the operator (or the orchestrator on next tick) can choose to resume vs. discard.

Tradeoff: stale worktrees accumulate; needs a sweep policy.

### Recommended combination

- **Mechanism 4** (keep aborted worktrees) is the foundational change — removes the data loss
- **Mechanism 1** (periodic auto-commit, rebased away on success push) gives recoverable file state
- **Mechanism 2** (session-id resumption) gives the dev conversation context to continue intelligently

Together: the orchestrator on retry can detect a recoverable abort, reuse the worktree, resume the conversation, and amend/append to the prior commit chain.

## Acceptance Criteria

- [ ] #1 Spec the resume protocol: when does retry kick in, what state is preserved, how does dev know it's resuming
- [ ] #2 Implement Mechanism 4 (don't auto-rollback on abort; instead emit `OrchestratorTaskAbortedRecoverable` event with worktree preserved)
- [ ] #3 Implement Mechanism 1 (periodic checkpoint commits with `wip(checkpoint):` prefix; squashed via autosquash before final push)
- [ ] #4 Implement Mechanism 2 IF Claude Code session-id semantics support it (verify experimentally first); otherwise document as future work
- [ ] #5 Add a "recoverable interruption" path in `cli-orchestrator tick`: when starting dispatch for task X, check if there's a prior aborted-recoverable worktree → if yes, resume; if no, fresh dispatch
- [ ] #6 Operator runbook documents the resume protocol + how to manually resume / discard a stuck recoverable worktree
- [ ] #7 Integration test: kill a dev mid-Edit, run tick again, verify dev picks up where it left off

## References

- `pipeline-cli/src/orchestrator/loop.ts` (dispatch + rollback paths)
- `pipeline-cli/src/runtime/shell-claude-p-spawner.ts` (subprocess management)
- AISDLC-177 (current rollback-on-abort path that removes the worktree)
- AISDLC-228 (Step 3 quarantine guard — preserves data via `quarantine/<task-id>-<ts>` ref; this task generalizes that pattern)
- Operator request 2026-05-08: "we should have the ability to recover from interrupted orchistrator runs so we don't loose the work we were doing"
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Spec the resume protocol (when triggers, what state preserved, how dev knows)
- [ ] #2 Don't auto-rollback on abort; emit OrchestratorTaskAbortedRecoverable event
- [ ] #3 Periodic checkpoint commits during dev work
- [ ] #4 Session-id resumption (if Claude Code supports it; else future work)
- [ ] #5 Tick checks for prior aborted-recoverable worktree and resumes if present
- [ ] #6 Operator runbook documents resume + manual override
- [ ] #7 Integration test: kill mid-Edit, retry, dev continues
<!-- SECTION:ACCEPTANCE:END -->
