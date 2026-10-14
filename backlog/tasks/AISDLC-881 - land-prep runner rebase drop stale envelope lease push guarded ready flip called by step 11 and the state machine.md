---
id: AISDLC-881
title: 'feat(pipeline): land-prep runner - rebase, drop stale envelope, lease push so the hook re-signs, guarded ready flip; called by Step 11 and by the state machine'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, phase-2, pipeline, dispatch]
dependencies: [AISDLC-829]
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - scripts/check-attestation-sign.sh
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
---

## Context

RFC-0054 OQ-7 (resolved 2026-10-14): Step 11 stays with the executor through the ready flip; the mechanical landing path is extracted into one deterministic runner that both Step 11 and the state machine call. Today the path "rebase + drop stale envelope + lease push, hook re-signs; REST flip" exists only as a hand sequence recorded in the 2026-10-11 planner handoff and as pieces inside the execute pipeline; the machine (AISDLC-829) has no CLI for post-ready skew or for taking over a dead executor's PR after signing (OQ-2).

## Fix

**Five-step review (requirements first).** Requirement questioned: "the machine should flip PRs to ready". No: the flip is the executor's last act (OQ-2); what the machine needs is the same guarded code path, callable. Deleted: the hand sequence from the handoff and the duplicated rebase logic in the execute pipeline. Simplified: one runner, one precondition check, two callers. Accelerated: a skew red becomes one command. Automated last: the state machine's `push-only-resign-resume` and `requeue-hand-review-path-resume` actions call it.

1. `cli-pr land-prep <pr> [--flip] [--worktree <path>]` (pipeline-cli): in the PR's worktree, fetch, rebase onto `origin/main` (abort and exit non-zero with the conflicting paths on a semantic conflict; mechanical conflicts per the rebase-resolver rules), remove a stale envelope whose subject no longer matches, run the heartbeat, lease push with `--force-with-lease=<branch>:<sha>` so `check-attestation-sign.sh` re-signs. Never bypasses a hook.
2. `--flip`: precondition check in code: CodeQL check run success on the head, verdict approved by state (the aggregate verdict file, not a phrase in a comment), no `CHANGES_REQUESTED` review outstanding; then PATCH `draft=false` over REST. Fails closed with the unmet condition named.
3. Step 11 calls `land-prep` before the first push when the base is stale, and `land-prep --flip` at the end of the executor's round; the inline code it replaces is deleted.
4. The state machine's skew actions (`push-only-resign-resume`, `requeue-hand-review-path-resume`) and its takeover-after-death path call the runner; a semantic conflict returns the PR to the executor by `reenter` (AISDLC-882).

## Acceptance Criteria

- [ ] On a BEHIND PR with a mechanical conflict, `land-prep <pr>` leaves the PR rebased, re-signed (new envelope, `ai-sdlc/attestation` success on the new head) and lease-pushed; no hook was skipped (test asserts no `AI_SDLC_SKIP_*` in the environment of the push).
- [ ] On a semantic conflict it exits non-zero naming the conflicting paths and leaves the branch unchanged.
- [ ] `--flip` refuses when CodeQL is not green or the verdict is not approved, naming the condition; flips otherwise.
- [ ] Step 11's inline rebase and flip code is removed; its tests call the runner.
- [ ] The 2026-10-11 hand sequence is documented as replaced in `docs/operations/attestation-reference.md`.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; one real PR taken from BEHIND to armed by the runner.

## Out of scope

The `reenter` command (AISDLC-882); event ingest (AISDLC-880).
