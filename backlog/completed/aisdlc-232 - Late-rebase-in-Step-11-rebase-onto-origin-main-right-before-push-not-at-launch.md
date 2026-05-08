---
id: AISDLC-232
title: >-
  Late-rebase in Step 11 — rebase onto origin/main right before push, not at
  launch
status: Done
assignee: []
created_date: '2026-05-07 21:35'
labels:
  - enhancement
  - pipeline-cli
  - rfc-0012
  - dogfood
dependencies: []
priority: high
references:
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - ai-sdlc-plugin/commands/execute.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Today the pipeline rebases the worktree onto `origin/main` ONCE, at agent-launch time (Step 3 — `git worktree add … origin/main`). The dev subagent then works for 20-40 minutes. By the time Step 11 (push-and-pr) runs, `origin/main` may have moved by N commits, often containing the same shared-file edits the dev re-derived independently.

When the dev's branch lands (via merge queue), the queue's own rebase produces conflicts that didn't exist when the work started. Operators report:

> "TASK-658 cherry-pick blew up with 14 'both added/modified' conflicts. The agent's worktree had been rebased before TASK-654/656/657/664 landed; by the time TASK-658 finished, the agent's commit re-derived all of those (with subtly different formatting/structure)." (Alex, 2026-05-07 forge dogfood)

The conflict cost is paid TWICE: once by the queue trying to rebase + run CI, and again by the operator manually resolving via `git checkout -- <files>`.

## Why this matters

For RFC-0015's autonomous orchestrator vision (operator AFK + parallel dispatch), every fan-out task hits stale-rebase risk. A late-rebase-before-push step:

1. Catches mechanical conflicts at the EARLIEST possible moment (the worktree, before push)
2. Auto-resolves trivial conflicts (CHANGELOG `Unreleased` lists, test additions to same `describe` block, prettier drift) — patterns the existing `/ai-sdlc rebase` skill already handles for PR-level rebases
3. Escalates hard conflicts to operator BEFORE producing a half-merged PR
4. Makes the merge-queue's job purely additive (same diff against fresh main → no rebase work needed)

## Proposed design

### Step 11 prelude: rebase-onto-main

Before `git push` in `pipeline-cli/src/steps/11-push-and-pr.ts`, add:

```typescript
async function rebaseOntoMain(opts: PushOpts): Promise<RebaseOutcome> {
  await git(['fetch', 'origin', 'main'], { cwd: opts.worktreePath });
  const { status, stdout } = await git(['rebase', 'origin/main'], { cwd: opts.worktreePath, allowFailure: true });
  if (status === 0) return { kind: 'clean' };

  // Mechanical conflict — try the auto-resolve patterns from /ai-sdlc rebase
  const resolved = await tryAutoResolve(opts.worktreePath);
  if (resolved.kind === 'all-resolved') {
    await git(['rebase', '--continue'], { cwd: opts.worktreePath });
    return { kind: 'auto-resolved', resolved: resolved.files };
  }

  // Hard conflict — abort the rebase and escalate
  await git(['rebase', '--abort'], { cwd: opts.worktreePath });
  return {
    kind: 'hard-conflict',
    files: resolved.unresolvedFiles,
    message: `Rebase onto origin/main produced conflicts in ${resolved.unresolvedFiles.length} file(s) that the auto-resolver couldn't handle. Escalating to operator.`,
  };
}
```

### Re-sign attestation if contentHashV4 shifted

`/ai-sdlc rebase` already re-signs attestation only when contentHash changed (the v4 hash is base-independent so it usually doesn't shift on a clean rebase, but DOES shift if any file was modified during conflict resolution). Apply the same pattern: if the rebase produced any new commits or modified the index, recompute contentHashV4 and re-sign.

### Escalation pathway

On `hard-conflict`:
- Pipeline returns `{ outcome: 'rebase-conflict', files, message }`
- Worktree is left in pre-rebase state (the `--abort` rolls back)
- The rebase-conflict outcome is NEW alongside the existing `developer-failed` / `developer-json-contract-violated` / `aborted` taxonomy
- Orchestrator records this as `outcomes[i].failure: { type: 'rebase-conflict', message }` (composes with AISDLC-229's pipeline.failure shape)

## Acceptance Criteria

- [ ] #1 Step 11 (`pipeline-cli/src/steps/11-push-and-pr.ts`) runs `git fetch origin main && git rebase origin/main` BEFORE the first `git push`
- [ ] #2 If rebase is clean, push proceeds as today (no behavior change for the happy path)
- [ ] #3 If rebase produces conflicts, attempt auto-resolve via the `/ai-sdlc rebase` patterns: CHANGELOG `Unreleased` blocks, test additions to same `describe`, prettier drift — share code with the existing `cli-rebase` implementation
- [ ] #4 On auto-resolve success, continue the rebase + recompute contentHashV4 + re-sign attestation IF the hash shifted (composes with the existing chore-commit pattern at Step 10)
- [ ] #5 On auto-resolve failure (hard conflict), abort rebase + return outcome `rebase-conflict` with the conflicting file paths in the result envelope
- [ ] #6 Orchestrator's tick (per AISDLC-229's umbrella wiring) records `rebase-conflict` outcomes as `outcomes[i].failure: { type: 'rebase-conflict', files, message }` and continues to the next task — does NOT block the entire tick
- [ ] #7 Hermetic test fixtures: (a) clean rebase fast-forwards, (b) auto-resolvable conflict resolves + push proceeds, (c) hard conflict aborts cleanly + outcome envelope is well-formed
- [ ] #8 Integration test: dispatch 2 fixture tasks both touching `pipeline-cli/CHANGELOG.md` (Unreleased section); verify the second task's late-rebase auto-resolves the CHANGELOG conflict and ships
- [ ] #9 Operator runbook updated at `docs/operations/operator-runbook.md` (or skill body if pipeline-cli/skill split exists) with the new outcome type + escalation flow
- [ ] #10 Composes cleanly with AISDLC-231 (hot-file dispatch serializer): the serializer prevents most overlap; this Step 11 rebase catches whatever slips through

## Composes with

- **AISDLC-231** (hot-file dispatch serializer) — primary defense; this is the secondary safety net
- **AISDLC-229** (orchestrator tick → umbrella wiring) — provides the outcome shape this populates on rebase-conflict
- **`/ai-sdlc rebase` skill** (existing) — code reuse target for the auto-resolve patterns
- **AISDLC-228** (Step 3 quarantine guard) — same parallel-orchestrator-safety batch

## References

- `pipeline-cli/src/steps/11-push-and-pr.ts` (the step this modifies)
- `ai-sdlc-plugin/commands/execute.md` (slash command body's Step 11 description)
- `ai-sdlc-plugin/commands/rebase.md` (auto-resolve patterns to reuse)
- `pipeline-cli/src/cli/rebase.ts` (the existing PR-level rebase implementation — code-reuse target)
- Operator's "ai-sdlc plugin feedback for Dom.md" 2026-05-07 — Alex's report
- AISDLC-231 (sister task — hot-file serializer, same parallel-safety batch)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Step 11 fetches + rebases onto origin/main BEFORE first push
- [ ] #2 Clean rebase proceeds to push with no behavior change for happy path
- [ ] #3 On conflicts, attempt auto-resolve via /ai-sdlc rebase patterns (CHANGELOG, tests, prettier)
- [ ] #4 Auto-resolve success → recompute contentHashV4 + re-sign attestation if shifted
- [ ] #5 Hard conflict → abort rebase + return outcome `rebase-conflict` with conflicting files
- [ ] #6 Orchestrator records rebase-conflict in outcomes[i].failure; tick continues
- [ ] #7 Hermetic tests: clean / auto-resolvable / hard-conflict paths
- [ ] #8 Integration test: 2 tasks touching CHANGELOG.md Unreleased; second auto-resolves
- [ ] #9 Runbook updated with new outcome + escalation flow
- [ ] #10 Composes with AISDLC-231 hot-file serializer
<!-- SECTION:ACCEPTANCE:END -->
