---
id: AISDLC-806
title: >-
  check-sender refuses every real dispatch message: match the harness uds session ref by pid
status: Done
assignee: []
created_date: '2026-10-10'
labels:
  - dispatch
  - executor
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/peer-guard.ts
  - ai-sdlc-plugin/commands/executor.md
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context.** Executors run `cli-hierarchy check-sender --board-dir <board> --sender-ref "<ref the harness reports>"` before acting on a peer message (`ai-sdlc-plugin/commands/executor.md`, from AISDLC-684 / DEC-0046 M1+M3). The harness reports the sender as `uds:/tmp/cc-socks/<pid>.sock` (the `from=` attribute of the cross-session message), with the name only in `from-name`.

**Cause.** `checkDispatchSender` in `pipeline-cli/src/hierarchy/peer-guard.ts` matches a ref only against the roster entry's `name` or `tmuxSession`, and never derives the pid from `<pid>.sock`. Every genuine dispatch message is therefore refused with "not my dispatch session".

**Reproduction (2026-10-10 23:20Z, 0.26.0 plugin build).** `check-sender --sender-ref uds:/tmp/cc-socks/16632.sock` is refused while the roster's operator-dispatch entry has pid 16632 and status running; `--sender-ref ai-sdlc-operator-dispatch` returns ok.

**Effect.** Since the guard shipped, dispatch could not deliver any ruling or fix note to an executor. Dispatch fell back to typing into tmux panes, which left prompts unsubmitted (gamma 22:10Z, beta 23:00Z) and stalled claims for hours.

**Five-step review (requirements first).**
1. Requirement: "an executor acts only on instructions from its own roster's dispatch session" (DEC-0046, security reviewer majors on AISDLC-684, planner). It is a mistake guard against look-alike dispatch sessions of other projects, not authentication; the board claim is already the authority and messages never carry assignments. Deleting the guard is a governance weakening and a class (b) decision for the operator, recorded separately; this task does not delete it.
2. Delete: the tmux-typing fallback in dispatch notes (prompts never submit). Dispatch directions stop prescribing it once this lands.
3. Simplify: one match rule. Parse `/(\d+)\.sock$/` from the ref and compare to the roster pid; keep name/tmuxSession matching.
4. Accelerate: none. 5. Automate: none.

**Fix.** In `peer-guard.ts`, `checkDispatchSender` derives `pidFromRef` from a ref matching `uds:` + a path ending in `<digits>.sock` and accepts when it equals a running dispatch entry's pid. Unit tests in the peer-guard/hierarchy test file cover the exact harness form. `executor.md` Step 2 example is updated to show the uds form; the executor's reply on refusal is unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A uds ref (`uds:/tmp/cc-socks/16632.sock`) whose pid equals the running dispatch entry's pid is accepted.
- [ ] #2 A uds ref with another pid (`uds:/tmp/cc-socks/99999.sock`) is refused, and a stopped dispatch entry is refused.
- [ ] #3 Name and tmuxSession refs (`ai-sdlc-operator-dispatch`) are still accepted.
- [ ] #4 No-ref / no-pid still accepts with the warning.
- [ ] #5 `ai-sdlc-plugin/commands/executor.md` documents the uds form in Step 2.
- [ ] #6 A live check from an executor pane against the real roster returns ok (manual, noted in the PR body).
<!-- AC:END -->

## Notes

Verification: `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`, `pnpm lint && pnpm format:check`. Velocity impact: positive; restores the dispatch-to-executor message path. Deleting the guard outright is a separate class (b) decision.
