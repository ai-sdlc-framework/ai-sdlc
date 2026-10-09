---
id: AISDLC-743
title: >-
  Claude Code mod: live context meter for the planner session with compact and
  clear actions
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - tooling
  - cost
  - dx
dependencies: []
references:
  - ai-sdlc-plugin/hooks/
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - docs/operations/
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The planner session has no visibility into its own context size or token spend; the only signal is the small `% ctx` figure in the status line, and the operator has to read /usage by hand. The 2026-10-06 audit (48 hours, 7,163 calls, 1.38 billion cache-read tokens, cache reads 86% of cost weight) found the planner averaged 176k tokens of context per call and peaked at 462k, and the dispatch session 343k average and 640k peak, because nothing made the growth visible or offered the clear at the right moment.

Requested by Dominique on 2026-10-06: a Claude Code mod, built with the plugin-authoring skill, that gives the planner session (first) a live band or status line showing current context tokens and percentage of the window, a progress bar that goes from green to amber to red as it approaches the clearing level (thresholds 10%, 13%, 15% of the window; 15% = the 150k ceiling), session token usage so far (input, cache write, cache read, output) with an approximate cost weight, and actions (buttons or key bindings) for /compact, /clear, and "hand off then clear" which first asks the session to write its handoff memory file and then clears.

Velocity impact: zero prompts on the happy path; the operator and the session see the ceiling coming and clear before a limit stall instead of after; the hand-off action makes the clear safe.

Sequencing: ship for the planner session first; dispatch and executor sessions can reuse it later.

Out of scope: automatic clearing without an action, changes to the hierarchy CLI, any server-side usage API. Standing rule from the operator's memory (feedback_one_task_per_context): executors run one task per context and are cleared afterwards; the planner hands off and clears at 150k tokens.

## Acceptance Criteria
- [x] A mod under the plugin (or a documented location the plugin-authoring skill prescribes) renders a live band or status line in the planner session with: context tokens and % of window, a colour-stepped progress bar (green under 10%, amber 10% to 15%, red at or above 15%), and session totals for input, cache-write, cache-read and output tokens with an approximate cost weight.
- [x] Actions for /compact, /clear and "hand off then clear" (writes the dated handoff memory file through the session, then clears); each action confirms once in the band, never with a modal prompt.
- [x] The mod hot-reloads during development and works in the terminal and the desktop Code tab; it degrades to no output (never an error) when the host does not expose context metrics.
- [x] Thresholds are configurable in one place and default to the values above.
- [x] A short page under `docs/operations/` explains how to enable it for the planner session and what each element means; the hierarchy doc links to it.
- [x] Tests cover the threshold-to-colour mapping and the token totals arithmetic.
- [x] Velocity impact paragraph in the PR body.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added a Claude Code mod at `ai-sdlc-plugin/mods/context-meter/` that draws a live band above the prompt in the planner session: context tokens and % of window, a green/amber/red bar (10/13/15%), session token totals with a cost weight, and Compact, Clear and Hand off + clear actions, each confirmed once inline.

## Changes
- `ai-sdlc-plugin/mods/context-meter/` (new): mod manifest, hooks, pure logic in `hooks/meter.ts`, state contract.
- `ai-sdlc-plugin/mods/tests/context-meter.test.ts` (new): node --test coverage for colour mapping, totals arithmetic and the hand-off state machine.
- `docs/operations/context-meter.md` (new), `docs/operations/cli-hierarchy.md` (link).
- `package.json` (`test:context-meter` added to `test`), `eslint.config.mjs` (mods folder ignored; compiled by the host).

## Design decisions
- **Hand-off clear bound to the hand-off prompt's own turn**: a pure `handoffStep` state machine, so an earlier in-flight turn or a tool-use step never clears early.
- **Thresholds all-or-nothing when unordered**: invalid fields fall back per field; an unordered trio discards all overrides (documented).
- **Cache totals are summed per turn**: the host exposes no running cache-write/read totals, so they start at zero on mod load and reset on /clear.

## Verification
- `pnpm build` — clean
- `pnpm test:context-meter` — 12 pass; `pnpm dark-code:check` OK; `claude plugin validate` OK
- `pnpm test` — only unrelated pipeline-cli failures (bin-invocation, environment dependent)
- `pnpm lint`, `pnpm format:check` — clean
- 2 parallel reviews approved (code-reviewer, security-reviewer; codex quota exhausted so Claude-native code review)

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
