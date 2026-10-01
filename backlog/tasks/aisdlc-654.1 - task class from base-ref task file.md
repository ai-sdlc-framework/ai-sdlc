---
id: AISDLC-654.1
title: >-
  RFC-0050 follow-up: resolveModel reads the task class from the base-ref task file, not the worktree copy
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - model-routing
  - security
dependencies:
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security finding on AISDLC-654: the task class that selects a routing cell is read from
the worktree's task file, which the developer agent can edit, so a developer could
move its own task into a cheaper cell. The same review suggested verifying
`origin/main` against the remote with a network call; that part is **declined**: the
whole framework resolves trusted config from the local `origin/main` ref
(`reviewer-set.ts`, governance, routing table), and adding a network check to one
reader changes nothing about the trust model of the others.

## Scope
Read the task's `class` (and any other field that feeds cell selection) from the base
ref's copy of the task file (`git show origin/main:<path>`), never from the worktree
copy; when the file does not exist on the base ref (a task created in the same PR),
use `uncategorized` and record the reason in the assignment log.

## Acceptance Criteria
- [ ] A worktree edit to the task file's `class` does not change the resolved cell; the base-ref value does.
- [ ] A task file absent from the base ref resolves to `uncategorized` with the reason logged.
- [ ] The declined network verification is recorded in the PR body as not implemented, with this reason.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
