---
id: AISDLC-1032
title: >-
  A token-verified executor start stays verified for re-issued starts until the next clear
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/executor-start.ts
  - pipeline-cli/src/hierarchy/start-token.ts
  - ai-sdlc-plugin/commands/executor.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (2026-10-22).** After the start token landed (clear writes a token that `executor-start` consumes), executor-alpha was cleared, its first `executor-start` consumed the token, waited the full window and found no eligible task (`taskId: null`). The executor skill then says: keep the context and re-issue the same `executor-start` call. That second call has no sender flag (the harness reports no pid or ref for a typed start) and the token is already consumed, so it is refused with `unchecked-start` and the executor sits idle while two tasks are queued. Dispatch can only recover it with another clear, which reloads the whole context for nothing.

**Root cause.** `consumeStartToken` deletes the token on the first verified start. Verification is tied to one call, while the skill's idle loop issues many calls per session. The property that matters is "this session was started by a clear and has not been cleared since", which outlives the first call.

**Five-step review (requirements first).**
1. Requirement questioned: "a token is good for exactly one start". Replaced by: a token verifies a session; every `executor-start` from that session is verified until the next clear writes a new token or the token ages out.
2. Delete: the single-use consumption. Nothing else to delete.
3. Simplify: `consumeStartToken` becomes `verifyStartToken`: it checks the token's executor name, dispatch pid and age (keep `START_TOKEN_MAX_AGE_MS` as the ceiling for the FIRST start) and records a `verifiedAt` timestamp in the token file instead of removing it. A later start with a `verifiedAt` set is accepted regardless of age, because the session is the one the clear started; `cli-hierarchy clear` overwrites the file, so a new session never inherits the old verification. A claimed task also clears the file (the claim is the authority from then on, and the next start after a verdict comes from a clear anyway).
4. Accelerate: the refusal text for a missing token names the two ways in (a clear, or the harness-reported sender flag) so the executor's one-line report says which is absent.
5. Automate: unit tests: first start within age verifies and marks; second start after a null wait is accepted; a start after `clear` rewrote the token for a different pid is refused; a start after a claim (file removed) without a flag is refused; an unverified token older than the ceiling is refused.

**Velocity impact.** Positive: an idle executor keeps its 25-minute wait cadence with no clear and no context reload; dispatch stops clearing idle executors to recover them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A second `executor-start` from the same session after a `taskId: null` wait is accepted without a sender flag (unit test)
- [ ] #2 A start token verified once is refused after `cli-hierarchy clear` rewrites it for another dispatch pid, and after a claim removed it (unit tests)
- [ ] #3 The age ceiling applies to the first verification only; a verified token is accepted after the ceiling (unit test)
- [ ] #4 `ai-sdlc-plugin/commands/executor.md` and `docs/operations/cli-hierarchy.md` state that re-issued starts need no flag until the next clear
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
- Manual: clear an executor on an empty queue; after its first wait lapses, the re-issued `executor-start` in the same session claims the next queued task instead of refusing with `unchecked-start`.
