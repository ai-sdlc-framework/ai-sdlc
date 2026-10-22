---
id: AISDLC-1029
title: >-
  `cli-hierarchy clear` confirms the resume command was submitted and fails loudly instead of reporting a degraded clear
status: In Progress
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/auto-clear.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (2026-10-22).** Most executor clears today returned "cleared (it did not report back within the 30000 ms ceiling)". On two of them (executor-delta at 19:49Z, executor-alpha at 20:00Z) the pane showed the resume command `/ai-sdlc:executor` sitting in the input line, not submitted, under the previous turn's output, while an old background shell of the refused round was still running. The start token of AISDLC-1028 had been written, so the only missing piece was the submission. Dispatch has no sanctioned way to press Enter in a pane, so each such executor stays idle until a person intervenes; the "degraded" result hides that the session never restarted.

**Root cause.** `clear` types `/clear`, then the resume command, each followed by one `Enter`, and treats a missing identity line within the ceiling as a soft "degraded" result. It never checks that the input line is empty after the Enter, and it has no retry, so a swallowed Enter (slash-command completion popup, a busy input line) leaves the command typed but unsubmitted.

**Five-step review (requirements first).**
1. Requirement questioned: "a clear that gets no reply within the ceiling is merely degraded". Replaced by: a clear either restarted the session (identity line seen) or failed, and the result says which and why.
2. Delete: the "degraded" wording and the `resumed:false` success path for a typed-but-unsubmitted command.
3. Simplify: after typing the resume command and Enter, read the pane; while the input line still holds the resume command, send `Enter` once more (at most twice, 2 s apart); if it still holds it, send `Escape` and retype once. Then wait for the identity line as today.
4. Accelerate: a clear that still sees no identity line returns `ok:false` with `reason: "resume command not submitted"` plus the last pane line, so the dispatch tick reports it as a blocker instead of moving on.
5. Automate: unit tests with a fake `run` whose pane keeps the command in the input line for N reads (submitted on the second Enter; submitted after Escape and retype; never submitted → failure with reason).

**Velocity impact.** Positive: an idle executor is detected at the clear, not two ticks later by a human reading pane text.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 After typing the resume command, `clear` re-sends Enter (at most twice) while the pane input line still holds the command, then falls back to Escape and one retype (unit tests for both paths)
- [ ] #2 A clear that never sees the identity line returns `ok:false` with reason `resume command not submitted` and the last pane line; the word "degraded" no longer appears in its output
- [ ] #3 `auto-clear` (the Stop-hook self-clear) uses the same path
- [ ] #4 `docs/operations/cli-hierarchy.md` describes the submission check and the failure result
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
- Manual: `cli-hierarchy clear <idle executor>` from the dispatch session restarts the executor loop (identity line appears) or returns `ok:false` with the pane line.
