---
id: AISDLC-1044
title: 'subagent-start hook: keep its spawn-sequence markers out of the checkout (gitignore or state dir) so a clean parent stays clean'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - hooks
  - plugin
dependencies: []
references:
  - ai-sdlc-plugin/hooks/subagent-start.js
  - .gitignore
  - scripts/check-orchestrator-state.sh
priority: medium
dispatchable: true
---

## Description

`ai-sdlc-plugin/hooks/subagent-start.js` writes zero-byte sequence markers `.ai-sdlc/subagent-spawn-seq/.seq-<n>` into the current checkout every time a session spawns a subagent. The path is not gitignored. When the session is the planner, whose working directory is the Pattern C parent, the markers make the parent dirty, and `scripts/check-orchestrator-state.sh` then refuses the dispatch tick's parent upkeep until someone deletes them by hand (observed 2026-10-22 after the planner ran one survey subagent: seven markers, tick blocked). Same failure class as the memory-dream output fixed for the Step 0.5 abort.

Fix at the source: either write the markers under `.ai-sdlc/state/` (already ignored) or add `.ai-sdlc/subagent-spawn-seq/` to `.gitignore`; prefer the state directory so adopters inherit the fix without a gitignore change. Keep the sequence semantics identical.

**Five-step review (requirements first).** Requirement questioned: does the hook need a file marker at all, or can the sequence live in memory? Markers survive across hook processes, so a file is needed, but it never needs to be in the tree. Deletion: nothing to delete. Simplified: one path change in the hook, no new config. Accelerated: the dispatch tick no longer stalls on a dirty parent after a planner subagent. Automated last: nothing new; `check-orchestrator-state.sh` keeps its dirty-tree refusal.

## Acceptance Criteria

- [ ] After a subagent spawn in a clean checkout, `git status --porcelain` stays empty (node --test covering the hook with a temp repo).
- [ ] Existing sequence-number behaviour of `subagent-start.js` unchanged; its current tests pass.
- [ ] If the gitignore route is chosen, `.gitignore` carries the entry with a one-line comment naming the hook.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
