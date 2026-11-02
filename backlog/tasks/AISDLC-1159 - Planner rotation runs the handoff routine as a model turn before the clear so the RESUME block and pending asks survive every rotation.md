---
id: AISDLC-1159
title: 'Planner rotation runs the handoff routine as a model turn before the clear, captures the last reply from the transcript, and resumes with it, so the RESUME block and pending operator asks survive every rotation'
status: To Do
assignee: []
created_date: '2026-11-02'
labels:
  - hierarchy
  - planner
  - context
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - ai-sdlc-plugin/hooks/hierarchy/context-size.ts
  - pipeline-cli/src/hierarchy/handoff.ts
  - ai-sdlc-plugin/commands/planner.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

At 2026-11-02 17:24:55Z the planner crossed 150k tokens mid-turn and the hierarchy module rotated it at turn end: it queued `/ai-sdlc:hierarchy handoff write --role planner`, then `/clear`, then `/ai-sdlc:planner` with no arguments. The handoff write ran as a bare CLI pass-through turn on Haiku and regenerated only the state block between the markers (roster, board, briefs, rulings, ledger). Nothing refreshed the `## RESUME HERE` prose, which still dated from ~07:35Z, and nothing recorded the two task drafts (AISDLC-1157, AISDLC-1158) that sat in the session scratchpad awaiting the operator's go. The restarted planner knew none of it until the operator asked. Three defects combine:

1. `rotate()` (`executor.ts:350`) runs `handoff write` as a slash command, never a model turn, so the Handoff routine in `planner.md` (step 2: write the RESUME block with open rulings, owed items, pending asks, next free ids) never runs on a module rotation. Only an operator saying "handoff" triggers it.
2. `last-reply:` can never be passed: `plannerTurnComplete` reads `e.text ?? e.reply` (`planner.ts:138`) but the host's `turn.complete` payload carries only `{event, reason, turnId, usage}` (AISDLC-1100 left planner reply capture as skipped), so `state.lastReply` is always empty and `/ai-sdlc:planner` resumes bare.
3. `register.tsx:133` nulls the rotation record using the executor's `resumePending`, not the active role's, so a planner rotation record can be wiped if the host fires `session.start` after the clear (latent; did not fire here).

**Five-step review (requirements first).**
1. Requirement questioned: must a rotation lose anything the operator would have to re-tell? No. The planner's own command text already says a clear "loses nothing" and the operator confirmed on 2026-11-02 that continuity without a reminder is the requirement. The question is whether the state block can carry it; it cannot, because pending asks and drafts live only in the conversation.
2. Delete: the `e.text ?? e.reply` read in `plannerTurnComplete`, which has never produced a value; the dead `last-reply:` branch in `resumeAfterClear` is kept but fed from a real source.
3. Simplify: one mechanism, not two. When `pendingRotate` is set at turn end, the module submits ONE prompt turn ("Handoff routine: run `handoff write --role planner`, then rewrite the `## RESUME HERE` block with open rulings, owed items, pending operator asks with the exact draft paths, next free task and decision ids, what each peer waits on; reply with the file path only") and rotates when THAT turn completes. The RESUME block is then written by the model that holds the context, with the same routine the operator triggers by hand.
4. Accelerate: the last reply comes from the transcript's last assistant text record (as `context-size.ts` already reads the transcript for usage), stored at `turn.complete`, so `/ai-sdlc:planner last-reply: ...` works on the next resume without waiting for a host payload change.
5. Automate: module tests cover the two-step rotation (prompt turn, then clear), the transcript-sourced last reply, the role-correct `resumePending` check, and the operator line printed when a threshold rotation is scheduled.

Velocity impact: every planner rotation (at least one per long operator session) stops costing an operator reminder and a transcript archaeology round; outward work (unfiled drafts, pending gos) can no longer be silently dropped by a clear.

## Acceptance Criteria

- [ ] AC-1: When the planner module sets `pendingRotate`, the end of that turn submits a handoff prompt turn (text defined once in `planner.ts`, mirroring the Handoff routine in `planner.md` steps 1-2) and marks `handoffTurnPending`; the `/clear` runs only when that turn completes. If the prompt turn fails or is refused, the module falls back to the current CLI-only `handoff write` and logs `handoff turn refused; state block only`.
- [ ] AC-2: The handoff prompt text requires the RESUME block to name: open rulings, owed items, pending operator asks with the absolute paths of any drafts in the scratchpad, next free task id and decision id, scheduled jobs, and what each peer waits on. `planner.md`'s Handoff routine is updated to say the module runs this routine on threshold rotation and the operator word only triggers it earlier.
- [ ] AC-3: `plannerTurnComplete` captures the last assistant text from the live transcript (reusing the transcript path resolution in `context-size.ts`) and stores it under `hierarchy/last-reply/<name>`; the dead `e.text ?? e.reply` read is removed. `resumeAfterClear` passes it as `last-reply: <text>` (truncated to a documented cap, e.g. 4000 chars) and the planner prints it labelled `Last reply before the clear:`.
- [ ] AC-4: `register.tsx` decides whether to keep the rotation record from the state of the role named in the record, not `router.executor`; a test rotates the planner, fires `session.start`, and asserts the record survives and the resume runs once.
- [ ] AC-5: When a threshold rotation is scheduled, the module prints one operator-visible line (`planner: context 1xxk, rotating at end of this turn; handoff routine runs first`) and logs it; `cli-hierarchy status` shows `rotate pending` for that session.
- [ ] AC-6: Docs: `docs/operations/cli-hierarchy.md` rotation section describes the two-step rotation (handoff turn, then clear), the transcript-sourced last reply, and what the RESUME block must carry.
- [ ] AC-7: Tests: `node --test` module tests for AC-1, AC-3, AC-4, AC-5 with a fake host; existing rotation tests still pass.

## Notes

- Out of scope, follow-ups to file separately if wanted: the 150k threshold is hardcoded at `planner.ts:21` and ignores `contextThresholds` in `config.json` (`thresholds.ts` is read only by `status`); the generated handoff block could gain a `## Pending asks` section fed by a `handoff note --kind pending` ledger entry.
- Related: AISDLC-1150 (dispatch over-context hard restart, dispatch side only), AISDLC-1100 (payload fields; planner reply capture skipped), AISDLC-933 (one RESUME block plus archive), AISDLC-889 (`handoff read` shape).
- Incident: planner rotation 2026-11-02 17:24:55Z, archived transcript `.claude/transcripts/20261102T172505Z-clear-88f72a09-53e1-443f-8262-bdb255cb86d1.jsonl`; drafts AISDLC-1157/1158 recovered from the previous session scratchpad and filed 2026-11-02 ~17:31Z and ~17:46Z.
