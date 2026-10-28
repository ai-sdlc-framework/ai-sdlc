---
id: AISDLC-1100
title: 'hierarchy module: measuredTokens reads the host session.measure payload (context.tokens) and the verdict check no longer depends on a reply text the turn.complete payload does not carry, so planner and executor auto-clear fire'
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - pipeline-cli/src/hierarchy/context-size.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Observed 2026-10-28: the planner session reached 154k tokens (`cli-hierarchy status` CONTEXT column, threshold 150000) on a freshly relaunched module (marker `module-ai-sdlc-planner.json` loaded 17:24Z) and ended two turns without rotating. The same day all five executors reported verdicts and were never cleared (AISDLC-1099 holds the clear-path design fixes). The module's `hierarchy/log` store key has `[hierarchy] registered role=planner` lines and no line ever mentioning rotate, clear, handoff, compact or resume; `hierarchy/rotation` is null and no `hierarchy/last-reply/*` key exists. `rotate()` has never run in any session.

Cause: the module reads event fields the host does not send.

1. `measuredTokens(e)` in `ai-sdlc-plugin/hooks/hierarchy/executor.ts` reads `e.contextTokens ?? e.tokens ?? e.totalTokens`, else sums `input`, `cacheWrite`, `cacheRead`, `output` on `e.usage ?? e`. The host's `session.measure` payload carries the count at `e.context.tokens` (with `window` and `percent` beside it). The function therefore returns 0 on every measure, so `plannerSessionMeasure` (`planner.ts`, `measuredTokens(e) >= PLANNER_ROTATE_AT_TOKENS`) and the executor equivalent (120k) never set `pendingRotate`, and `turn.complete` never rotates because it only acts on that flag.
2. The executor `turn.complete` handler reads `String(e?.text ?? e?.reply ?? '')`; the host payload has `event`, `reason`, `turnId`, `usage` and no reply text, so `reply` is always empty, the verdict marker never matches, `state.active` never drops and the planner `last-reply` key is never written.
3. `MODULE=loaded` in `status` only records the `session.start` heartbeat (`module-health.ts`); it says nothing about the later hooks. `status` CONTEXT comes from the transcript's last usage record (`pipeline-cli/src/hierarchy/context-size.ts`), a different measurement from the module's.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the module infers the context size and the reply text from loosely guessed payload fields": the host defines the payload, so the module must read the documented fields and fail loudly when they are absent. Deleted: the four-name guessing chain in `measuredTokens` and the reliance on a reply text in `turn.complete` (verdict detection moves to board truth per AISDLC-1099; this task removes the text dependency). Simplified: one reader per event, each with a recorded fixture of the real payload. Accelerated: a `session.measure` above threshold now rotates at the very next turn boundary. Automated: a fixture test per hook event and a `status` health field that shows the module's last measured tokens and last rotation, so a 0 reading is visible on the first check.

1. `measuredTokens`: read `e.context.tokens` first, then the existing fallbacks; when no field yields a number, log one `[hierarchy] measure payload unrecognised: <keys>` line to `hierarchy/log` (once per session) instead of silently returning 0.
2. Capture one real `session.measure` and one real `turn.complete` payload from a live session into test fixtures (`ai-sdlc-plugin/hooks/hierarchy/__fixtures__/`), and assert `measuredTokens(fixture) === fixture.context.tokens`.
3. `turn.complete`: stop using `e.text`/`e.reply` for the verdict; use the board-truth check (verdict file for the claimed task, AISDLC-1099) and the `pendingRotate` flag. The planner `last-reply` store key is written from the harness reply when a field exists, otherwise skipped without affecting rotation.
4. Module health: write `lastMeasuredTokens`, `lastMeasureAt` and `lastRotationAt` into the module marker file; `cli-hierarchy status` shows them in a MEASURED column next to CONTEXT, and warns when CONTEXT exceeds the threshold while MEASURED is below it (the exact signature of this failure).
5. Tests: (a) real measure fixture over threshold with no turn running → `rotate()` called; (b) same with a turn running → `pendingRotate` set, rotate at `turn.complete`; (c) unrecognised payload → one log line, no rotation, no throw; (d) `status` warning when CONTEXT > threshold and MEASURED < threshold.
6. `docs/operations/cli-hierarchy.md`: document the payload fields the module depends on and the MEASURED column.

## Acceptance Criteria

- [ ] With the real `session.measure` payload shape, a planner at 150k or more rotates at the next turn boundary (handoff write, clear, `/ai-sdlc:planner`) without operator action.
- [ ] An executor at 120k or more rotates the same way.
- [ ] `cli-hierarchy status` shows the module's last measured token count and warns when it disagrees with CONTEXT across the threshold.
- [ ] An unrecognised payload shape is logged once and never silently read as 0.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
