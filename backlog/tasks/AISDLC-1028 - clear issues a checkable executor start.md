---
id: AISDLC-1028
title: >-
  A start issued by `cli-hierarchy clear` is checkable: the clear writes a start token that executor-start consumes when no sender flag is given
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - root-cause
  - hotfix
dependencies: []
references:
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
  - pipeline-cli/src/hierarchy/peer-guard.ts
  - pipeline-cli/src/hierarchy/caller-identity.ts
  - ai-sdlc-plugin/commands/executor.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (drain outage, 2026-10-22 ~19:40Z).** Since PR #1883 landed, `executor-start` refuses every start with `unchecked-start` when it receives neither `--sender-pid` nor `--sender-ref`. The executor command is delivered by `cli-hierarchy clear`, which types `/ai-sdlc:executor` into the executor's tmux pane with `send-keys`. A typed command has no harness message envelope, so there is never a sender pid or ref to pass: every normally issued start is now refused, and with all executors idle the queue (1021, 973, 978) cannot be claimed. Dispatch worked around it by sending each executor a cross-session message whose harness `from=` socket ref the executor passes as `--sender-ref`; that is a prose step dispatch must repeat after every clear.

**Root cause.** The refusal assumes the start always arrives as a harness message. The normal start arrives as typed text from `clear`, whose caller identity (the dispatch session, resolved from process ancestry by `resolveCaller`) is known at the moment it types the command but is not handed to the executor.

**Five-step review (requirements first).**
1. Requirement questioned: "the start's sender is proven by the harness envelope". Replaced by: the start's issuer is proven by whatever the issuing path can carry; for a typed start that is a token written by the `clear` command itself.
2. Delete: nothing to delete; the message-envelope path (`--sender-pid` / `--sender-ref`) stays as it is for starts that do arrive as messages.
3. Simplify: `clear` writes `<boardDir>/starts/<executor-name>.json` `{ issuerPid, issuerName, issuedAt }` from the caller identity just before it types the resume command; `executor-start`, when given no sender flag, reads its own token, requires `issuerPid` to equal the roster's running dispatch pid and `issuedAt` within 30 minutes, deletes the token (single use), then proceeds. Missing, stale, consumed or mismatched token: refuse with `unchecked-start` exactly as today. The planner-issued `cli-hierarchy clear` (planner caller) writes no token: only the dispatch caller does.
4. Accelerate: dispatch no longer sends a start message after each clear; the executor command text drops the "pass the pid or ref the harness reports" requirement for the typed start and keeps it for message-delivered instructions (`check-sender`).
5. Automate: unit tests for token write on clear (dispatch caller writes, planner caller does not), token consumption (fresh match passes once; second start refuses; stale or wrong pid refuses), and the unchanged flag path.

**Velocity impact.** Positive: restores the autonomous drain with no per-clear prose step; one more file write per clear.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-hierarchy clear` of an executor, run by the dispatch caller, writes `<boardDir>/starts/<executor-name>.json` with the issuer pid, name and time before typing the resume command (unit test); a planner caller writes none
- [ ] #2 `executor-start` with no `--sender-pid` and no `--sender-ref` proceeds when a fresh single-use token for its own name carries the roster dispatch pid, and deletes the token; it refuses with `unchecked-start` on a missing, consumed, stale (older than 30 min) or mismatched token (unit tests for each)
- [ ] #3 The `--sender-pid` / `--sender-ref` path is unchanged and still tested
- [ ] #4 `ai-sdlc-plugin/commands/executor.md` and `docs/operations/cli-hierarchy.md` describe the token path and keep `check-sender` for later messages
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
- Manual: `cli-hierarchy clear <executor>` from the dispatch session, then the executor's `executor-start` with no sender flag claims normally and the token is gone.
