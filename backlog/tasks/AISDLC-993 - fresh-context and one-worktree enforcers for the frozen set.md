---
id: AISDLC-993
title: 'Fresh-context and one-worktree-per-task become enforced invariants so they can join the frozen set'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - rfc-0056
  - attestation
  - hooks
dependencies: []
references:
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - ai-sdlc-plugin/hooks/subagent-start.js
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/steps/03-setup-worktree.ts
priority: medium
dispatchable: true
---

## Description

RFC-0056 OQ-3 (resolved 2026-10-20) kept two proposed frozen entries out of the set because nothing enforces them today: a frozen label with no enforcer is config that lies. This task builds the enforcers so a later document revision can add both entries.

**Scope.**
1. Fresh context. `ai-sdlc-plugin/hooks/subagent-start.js` writes a marker and `review-finalize.ts` (`resolveAgentIdFromMarkers`) resolves an agent id from it; nothing checks the context was new (AISDLC-568: a v6 envelope does not prove reviewer independence). The hook records, per spawn, the parent session id and a monotonically increasing spawn sequence; `review-finalize` refuses a reviewer whose marker shows a context reused from an earlier reviewer of the same round (same agent id seen twice, or a spawn sequence not greater than the previous reviewer's). The refusal is a critical finding, the same shape as a missing reviewer.
2. One worktree per task. `steps/03-setup-worktree.ts` relies on git's "branch already exists" refusal. The step checks the board (`dispatch/board.ts`) and `git worktree list` for an existing worktree bound to the task id and refuses to create a second one with a message naming the first; a resume reuses the existing worktree.
3. Both checks are deterministic and run in process (anchor-grade), so RFC-0056's validator can later list them as frozen with these files as enforcers.

**Five-step review (requirements first).**
1. Requirement questioned: is reviewer freshness worth proving, given the envelope never claimed independence? Yes for the staged-review promotion (RFC-0052 OQ-2), which compares reviewers; a reused context corrupts the comparison.
2. Delete: nothing; the markers stay, they gain two fields.
3. Simplify: one marker shape, one refusal shape shared with the missing-reviewer path.
4. Accelerate: a reused-context reviewer is caught in finalize, not in a later audit.
5. Automate: tests with a reused marker and a duplicate worktree, both refused.

## Acceptance Criteria

- [ ] The subagent-start marker carries the parent session id and a spawn sequence; a test with two reviewers sharing an agent id, or a non-increasing sequence, makes `review-finalize` emit a critical finding and the round fails closed.
- [ ] `03-setup-worktree` refuses to create a second worktree for a task id that already has one on the board or in `git worktree list`, naming the existing path; a resume for that task reuses it (test).
- [ ] Both enforcer paths are cited in a comment in the RFC-0056 default document's frozen list as "pending" entries, so the phase 4 task can activate them without a search.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass; hook tests run under `node --test`.
