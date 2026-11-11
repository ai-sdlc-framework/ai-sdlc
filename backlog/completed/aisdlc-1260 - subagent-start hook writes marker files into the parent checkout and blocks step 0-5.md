---
id: AISDLC-1260
title: 'subagent-start hook writes `.ai-sdlc/subagent-sessions/*.json` and `UNKNOWN-*` transcripts into the parent checkout; untracked files then block the next `next-step` at Step 0.5'
status: Done
assignee: []
created_date: '2026-11-11'
labels:
  - plugin
  - hooks
  - pattern-c
  - bug
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/hooks/subagent-start.js
  - ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - docs/operations/backlog-and-execution-reference.md
priority: high
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2622, plugin 0.42.0). Reproducible: the hook resolves projectDir to the parent checkout and writes marker files there on every subagent spawn.'
---

## Description

**Gap (issue #2622, observation 1).** `ai-sdlc-plugin/hooks/subagent-start.js` writes `.ai-sdlc/subagent-sessions/<agentId>.json` under `projectDir` on every spawn. In a Pattern C adopter the session cwd is the parent checkout, so the markers land in the parent, not in the task worktree. Reviewers spawned without a parent `.active-task` also try to write `.ai-sdlc/transcripts/UNKNOWN-*`. Both are untracked, so the next `next-step` run stops at Step 0.5 (`00-5-sync-parent.ts`, parent must be clean) until the operator deletes them by hand.

**Shape.** Marker and transcript writes resolve to the task worktree named by `AI_SDLC_ACTIVE_TASK_ID` or `.active-task`; when neither names a worktree, the hook writes under a gitignored location (or `.ai-sdlc/subagent-sessions/` is gitignored in the adopter scaffold) and never under `UNKNOWN-*`. Step 0.5 names the offending files when it refuses, so the operator sees the cause.

## Fix

**Five-step review.**
1. Requirement questioned: the marker is needed so `persist-reviewer-artifacts.sh` can map an agent id to its agent type. Stands.
2. Deleted: the `UNKNOWN-*` transcript write when no task is active (nothing downstream can use it).
3. Simplified: one resolver for the write root shared by the hook and the persist script.
4. Accelerated: no more manual cleanup between runs.
5. Automated: `ai-sdlc init` adds the ignore rule; a test covers the parent-cwd case.

## Acceptance Criteria

- [ ] AC-1: with `AI_SDLC_ACTIVE_TASK_ID` or `.active-task` naming a worktree, the hook writes the marker under that worktree's `.ai-sdlc/subagent-sessions/`; `node --test` case with a fake worktree.
- [ ] AC-2: with no active task, the hook writes no `.ai-sdlc/transcripts/UNKNOWN-*` file and the marker goes to a gitignored path; test.
- [ ] AC-3: `persist-reviewer-artifacts.sh` finds the marker at the new location (its lookup and the hook share the resolver); existing test updated.
- [ ] AC-4: Step 0.5 lists the untracked paths in its refusal message; test.
- [ ] AC-5: `ai-sdlc init` (or the manifest it reads) adds `.ai-sdlc/subagent-sessions/` to the adopter `.gitignore`; idempotent re-run test.
- [ ] AC-6: `docs/operations/backlog-and-execution-reference.md` documents where markers are written in Pattern C.
- [ ] AC-7: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
