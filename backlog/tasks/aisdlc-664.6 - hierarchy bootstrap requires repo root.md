---
id: AISDLC-664.6
title: >-
  RFC-0051 follow-up: cli-hierarchy up requires the repo root, sets
  CLAUDE_PROJECT_DIR per window, preflights policy
status: To Do
assignee: []
created_date: '2026-10-01'
updated_date: '2026-10-16 18:29'
labels:
  - rfc-0051
  - dispatch
  - cli
dependencies:
  - AISDLC-664
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
priority: low
drift_status: flagged
drift_checked: '2026-10-16'
drift_log:
  - date: '2026-10-16'
    type: ref-deleted
    detail: 'Referenced file no longer exists: docs/operations/parallel-dispatch.md'
    resolution: flagged
  - date: '2026-10-16'
    type: dep-resolved
    detail: Dependency AISDLC-664 has been completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Go (operator, 2026-10-30): the 2026-10-06 park is lifted; dispatchable.

Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

The governance hook resolves policy from `CLAUDE_PROJECT_DIR`; a session launched
from the non-repository parent directory fails closed to `allowForcePush: never`, so
every executor's lease push is blocked. Cross-reference AISDLC-664.5 (managed-settings
preflight, stuck `starting` entries, roster name hardening); this task is the launch
directory and policy preflight only.

## Scope
1. `cli-hierarchy up` refuses unless the current directory is the repository root or a
   worktree whose root resolves to it, naming the expected directory.
2. Every spawned window starts with its working directory at the repository root and
   `CLAUDE_PROJECT_DIR` set explicitly to it.
3. Preflight resolves and prints the effective `allowForcePush` value and the
   `operational` list the executors will see, so a fail-closed `never` is visible
   before any executor starts.
4. The runbook states the requirement.

## Acceptance Criteria
- [ ] `up` from a non-repository directory refuses and names the expected root; from a worktree it resolves to the root and proceeds.
- [ ] Each spawned command carries the root as working directory and `CLAUDE_PROJECT_DIR` (asserted on the injected runner).
- [ ] Preflight output shows the resolved `allowForcePush` and `operational` values from a fixture policy.
- [ ] The runbook documents the launch requirement.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
