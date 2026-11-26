---
id: AISDLC-1448
title: "A planner or executor session is never cleared or restarted until its handoff is written"
status: To Do
priority: high
labels:
  - hierarchy
  - handoff
  - context-rotation
  - adopter-facing
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/rotate-request.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
---

## Description

**Five-step review (requirements first).**
1. Question: on 2026-11-26 planner session 5c3dd8f7 reached 150,953 tokens (threshold 150,000) partway through an RFC-0049 OQ walkthrough, and the operator's answers were lost. What happened:
   - The dispatch tick queued a "rotate" at 21:45:28Z. The module never dequeued it. The session's last record is an `AskUserQuestion` tool_use at 21:45:42Z with no tool_result. The handoff prompt was never submitted (0 occurrences in the transcript).
   - At 21:49:02Z the dispatch session hard-restarted the planner (`.ai-sdlc/dispatch/restart-locks/ai-sdlc-planner.json`, holder `ai-sdlc-operator-dispatch`).
   - The `## RESUME HERE` block was still the one an earlier session wrote at 21:05Z. `handoff read` in the new session printed "no clear marker found", and its transcript digest pointed at the new session's own transcript, not the dying one ("Archived copy: (none)").
   - Recovering took the operator re-asking and a manual transcript dig.

   The requirement stands (operator, 2026-11-26): "that can't happen, we lose context and clients won't like that". A session must not lose its unrecorded working state to a clear or restart. Five gaps allow it, none gated on proof that the model rewrote the RESUME block:
   - (a) The dispatch hard restart (`dispatch-loop.ts:1036-1068`; after `ROTATE_GRACE_TICKS = 6`, line 964) runs once the session is not `busy`. A session waiting on a pending `AskUserQuestion` appears not busy (unchecked: `restart.ts:350-356`). `restart.ts:263-277` writes only the CLI state block, and a failed write does not stop the kill.
   - (b) The module clears on any `turn.complete` after the handoff prompt is submitted (`planner.ts:212-214`), including an interrupted or failed turn. Nothing checks for a new RESUME block, the state hash or the file's modified time.
   - (c) If a measure or "rotate" arrives while no turn is running, the module rotates at once and skips the handoff prompt (`planner.ts:152`, `:254`).
   - (d) `turnRunning()` stops counting a turn after `PLANNER_TURN_STALE_MS` (30 minutes, `planner.ts:77,91-94`). A long walkthrough turn passes that and then rotates at once.
   - (e) If the prompt submit is refused, the module clears with the state block only (`planner.ts:221-223`). `executor.ts:379-411` `rotate()` also clears when `handoff write` is refused (385-386).
2. Delete: the immediate-rotate branches in (c), (d) and (e), and the clear-on-any-turn-end in (b). Clearing without proof is never the right outcome. The hard restart itself stays only as the last resort described in AC #4.
3. Simplify: there is one proof predicate, `handoffWrittenSince(role, name, sinceIso)`, in pipeline-cli. It is true only when the session's handoff file holds exactly one `## RESUME HERE` block whose content hash differs from the hash recorded when the rotation was requested, and the file's modified time is later than the request. The module and the dispatch restart path both call it. Neither keeps its own notion of "written".
4. Accelerate: a pending operator question defers rotation. It does not trigger it. The handoff prompt goes in right after the answer comes back.
5. Automate: when proof never arrives, the system alerts instead of clearing. The dying transcript is always archived, so the next session can recover from it.

## Acceptance Criteria
- [ ] #1 `handoffWrittenSince` exists in pipeline-cli and is exported through `cli-hierarchy handoff verify --role <r> --since <iso>` (exit 0 = proven, 1 = not). Tests cover:
  - an unchanged RESUME block: not proven;
  - a regenerated state block only: not proven;
  - two RESUME blocks: not proven;
  - a new block written after `since`: proven.
- [ ] #2 Module (`planner.ts`, and `executor.ts` for executors):
  - every rotation submits the handoff prompt, including when idle, over the stale threshold or after a "rotate" message;
  - the clear runs only after `handoffWrittenSince` returns true;
  - if the handoff turn ends without proof, the prompt is resubmitted once;
  - if there is still no proof, the session is not cleared. The module logs `handoff unproven; not clearing` to a file under `.ai-sdlc/dispatch/` (not only `$.store`) and alerts the operator through the planner pane and the built-in notification.
  - Tests cover: an interrupted handoff turn; a refused submit; a turn older than 30 minutes; an idle session.
- [ ] #3 Pending operator question:
  - while an `AskUserQuestion` has no tool_result, the session counts as busy for both the module and `dispatch-loop.ts` / `restart.ts`;
  - rotation is deferred, and the handoff prompt is submitted on the first `turn.complete` after the answer;
  - a test replays the 2026-11-26 shape (a "rotate" queued, then AskUserQuestion pending past the grace period) and asserts no restart and no clear.
- [ ] #4 Dispatch hard restart (`restart.ts`):
  - it never kills a planner or executor window unless `handoffWrittenSince` is true for the current rotation request;
  - when the grace period lapses without proof, it files one escalation (`cli-decisions escalate`, scope `session-rotation:<name>`) and alerts the operator instead of restarting;
  - a failed `writeHandoff` blocks the restart; it is no longer a warning.
  - The only exception is the operator's explicit `cli-hierarchy restart <name> --force`, which is logged as such.
- [ ] #5 On every clear or restart, forced or not, the dying session's transcript path is recorded as the archived copy. In the next session, `handoff read` shows the dying transcript's last turns, not its own. Test: after a simulated restart, `handoff read` names the old transcript id.
- [ ] #6 `docs/operations/cli-hierarchy.md` and the "Context and handoff" section of `ai-sdlc-plugin/commands/planner.md` state the guarantee, the alert and the `--force` exception. The current wording, "runs it as a model turn … before the clear", is replaced, since it describes a sequence, not a gate.
- [ ] #7 The guarantee holds for adopters. The default plugin hooks module enforces it with no repo config.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Out of scope: Claude Code's own auto-compaction at the model's context limit. Name it in the PR if it can bypass this gate.
- Related completed tasks: AISDLC-1150 (the over-context restart "never kills a busy planner"), AISDLC-1159 (the handoff model turn), AISDLC-1163.
