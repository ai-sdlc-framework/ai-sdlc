---
id: AISDLC-1109
title: >-
  Decision escalation chain stops re-sending "Decision DEC-NNNN needs an answer" to the planner for a decision whose lifecycle is answered (DEC-0003 prompt repeated 4 times in one hour)
status: To Do
assignee: []
created_date: '2026-10-29'
labels:
  - hierarchy
  - decisions
  - stability
dependencies: []
references:
  - pipeline-cli/src/decisions/escalation-chain.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/decision-authority.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Between 2026-10-29 06:50Z and 07:20Z the planner session received the same prompt four times: `Decision DEC-0003 (design) needs an answer. Read it with: cli-decisions show DEC-0003`. DEC-0003 has been `answered` since 2026-10-07 (event `operator-answered`, chosen option `exempt`, visible in `cli-decisions show DEC-0003` and in `.ai-sdlc/_decisions/events.jsonl`); `cli-decisions list` shows no open decision. The text is the promotion notice built in `pipeline-cli/src/decisions/escalation-chain.ts` (the `needs an answer` template) and sent by `promoteExpiredDecisions`, which the dispatch tick calls from `pipeline-cli/src/cli/hierarchy.ts`. `findDueDecisions` filters on `lifecycle !== 'open'`, so either the tick loads decisions from a store that does not contain the 2026-10-07 answer (a stale per-event `events/` view, a cached index, or a different `workDir`), or the notice is a queued cross-session message that the planner's hooks module replays on every wake instead of once. Each replay costs the planner a turn and, under the overnight autonomous rules, a `cli-decisions show` call; a planner that trusted the prompt could re-answer an answered decision.

**Five-step review (requirements first).** Requirement questioned: "a tier promotion is announced every tick until the tier answers". Once announced, a promotion is a fact in the event log (`DecisionEscalated`); repeating the message adds nothing. Deleted: the re-announcement. Simplified: `promoteExpiredDecisions` emits `DecisionEscalated` once per (decision, toTier) and never notifies for a decision whose lifecycle is not `open` in the same loader `cli-decisions show` uses. Accelerated: the planner reads one prompt per promotion instead of one per tick. Automated: a test replays the real `events.jsonl` shape (opened, then operator-answered) through the tick's loader and asserts no notice; a second test asserts a notice is sent once and not again on the next tick; if the cause is message replay in the hooks module, the module marks a delivered message consumed (or the sender dedupes on a message id) and a test covers it.

Fix: find which of the two paths sends the notice (run the tick's loader against the parent `.ai-sdlc/_decisions` and log the lifecycle it sees for DEC-0003; check the planner session's inbox for a persisted copy of the message), fix that path, and add the two tests above.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] With `events.jsonl` holding `decision-opened` then `operator-answered` for DEC-0003, a dispatch tick sends no "needs an answer" notice for it (test using the same loader the tick uses).
- [ ] A due open decision is announced once per (decision, toTier); the next tick with no state change sends nothing (test).
- [ ] If the root cause is message replay by the hooks module, a delivered cross-session message is not re-delivered on a later wake (test), and the fix is documented in `docs/operations/decision-authority.md` or `docs/operations/cli-hierarchy.md`.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: planner session transcript 2026-10-29 06:50Z, 07:03Z, 07:12Z, 07:20Z, identical text each time; `cli-decisions show DEC-0003` lifecycle `answered`, events: opened 2026-05-28, operator-answered 2026-10-07T01:38Z; `cli-decisions list --format table | grep -v answered` empty; no file under `.ai-sdlc/dispatch` or `~/.ai-sdlc` contains the prompt text.
