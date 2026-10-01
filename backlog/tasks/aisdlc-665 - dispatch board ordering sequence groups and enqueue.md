---
id: AISDLC-665
title: >-
  RFC-0051 OQ-1: manifest after/sequenceGroup/priority/wave/blockedBy, claim rules, reaper requeue, cli-dispatch enqueue
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
  - board
  - schema
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - spec/schemas/dispatch-manifest.v1.schema.json
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/dispatch/session-reaper.ts
  - pipeline-cli/bin/cli-dispatch.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Turns the brief's ordering rules into properties of the board so the claim logic
enforces them. RFC-0051 section 4 and the OQ-1 resolution. The board protocol
(`queue/`, `inflight/`, `done/`, `failed/`, atomic claim by rename, heartbeats) stays
as it is.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages; `node --test`
  for plugin hooks and scripts; 80% line coverage on new code.
- Tests never start a real Claude Code session, never call tmux against the user's
  real server (inject the command runner), and never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Manifest fields** (`spec/schemas/dispatch-manifest.v1.schema.json`, additive):
   `after` (task ids), `sequenceGroup` (string), `priority` (integer), `wave`
   (integer), `blockedBy` (decision id). Regenerate generated schemas.
2. **Claim rules** in `pipeline-cli/src/dispatch/board.ts`: a manifest is eligible
   only when every id in `after` has a verdict in `done/`, no inflight manifest shares
   its `sequenceGroup`, and `blockedBy` is empty. Among eligible manifests the claim
   order is wave, then priority, then enqueue time. Claim remains an atomic rename.
3. **`blocked/`:** a new directory for parked manifests (see AISDLC-669); the claim
   logic never reads it; `cli-dispatch unblock <task-id>` returns one to `queue/`.
4. **Reaper** (`pipeline-cli/src/dispatch/session-reaper.ts`): an inflight manifest
   whose heartbeat is older than the limit, or whose claiming session is absent from
   the hierarchy roster when a roster exists, is returned to `queue/` with its retry
   count incremented; above the configured retry limit it goes to `failed/`.
5. **`cli-dispatch enqueue`**: `--task <id>` (repeatable) with `--after`, `--group`,
   `--priority`, `--wave` flags, or `--from-brief <path>` reading the brief format
   from AISDLC-668 (a brief without that command yet is a YAML list of the same
   fields). Refuses an id that is already on the board in any state.
6. **`cli-dispatch board`**: prints every manifest by state with its eligibility and,
   for ineligible ones, the reason.

## Acceptance Criteria
- [ ] A manifest with an unmet `after` is not claimable; it becomes claimable once the named task's verdict is in `done/`.
- [ ] Two manifests in the same `sequenceGroup` are never inflight together; the second is claimed only after the first reaches `done/` or `failed/`.
- [ ] Claim order among eligible manifests follows wave, then priority, then enqueue time (fixture with six manifests).
- [ ] A manifest with `blockedBy` set is skipped; `cli-dispatch unblock` returns it to `queue/` and it is claimed next.
- [ ] A stale inflight manifest is requeued with its retry count incremented, and one past the retry limit lands in `failed/`.
- [ ] `enqueue --from-brief` creates one manifest per listed task with the brief's ordering fields, and refuses a task already on the board.
- [ ] `cli-dispatch board` lists each manifest with its state and, for ineligible ones, which rule holds it.
- [ ] Existing manifests without the new fields are claimed exactly as before (existing board tests pass unchanged).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
