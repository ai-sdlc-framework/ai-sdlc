---
id: AISDLC-1152
title: 'SessionStart emits the AISDLC-782 fixed prefix; planner.md and CLAUDE.md shrink to pointers under the 10 KB prefix budget'
status: In Progress
assignee: []
created_date: '2026-11-01'
labels:
  - context
  - rfc-0053
  - hooks
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/fixed-prefix.js
  - ai-sdlc-plugin/hooks/lib/fixed-prefix.test.mjs
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/session-start.test.mjs
  - ai-sdlc-plugin/hooks/lib/hierarchy-role.js
  - ai-sdlc-plugin/commands/planner.md
  - CLAUDE.md
  - docs/operations/cli-hierarchy.md
  - docs/operations/agent-governance-reference.md
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
priority: medium
dispatchable: true
---

## Description

RFC-0053 (Signed Off) defines a fixed prefix of at most `prefix.maxBytes` (10240 bytes) holding only governance controls, the role and task frame, and pointers; everything explanatory moves to the knowledge index and is surfaced just in time. AISDLC-782 delivered `ai-sdlc-plugin/hooks/lib/fixed-prefix.js` (`buildFixedPrefix`, `renderFixedPrefix`, `PREFIX_MAX_BYTES`), but nothing at runtime calls it: its only importers are its own test and `scripts/lint-controls.mjs`. `ai-sdlc-plugin/hooks/session-start.js` still assembles its own governance block (governance header, hard rules, operational rules, review-policy banner, setup warnings, hierarchy role block with up to 12000 characters of handoff).

Meanwhile the planner's fixed context measured on 2026-11-01 includes `ai-sdlc-plugin/commands/planner.md` at 13,353 bytes (about 3.3k tokens) and `CLAUDE.md` at 11,938 bytes (about 3k tokens). Both explain in prose what the fixed-prefix design says should be a pointer.

**Five-step review (requirements first).**
1. Requirement questioned: must every session read the full planner command and project instructions on every turn? No. The controls that change behaviour belong in the prefix; the rest is reference material reachable by pointer (`docs/operations/`, `.claude/rules/*.md` which already load by path).
2. Delete: the duplicate governance rendering in `session-start.js` once the prefix module produces the same controls (it already shares `renderSessionStartHardRules`); the prose sections of `planner.md` and `CLAUDE.md` that restate `docs/operations/` content.
3. Simplify: one producer of the session-start text, `buildFixedPrefix`, with `session-start.js` passing role, task and pointers. The handoff block stays, as a pointer plus the RESUME block rather than 12000 characters.
4. Accelerate: a smaller, stable prefix keeps the cache hit on every turn.
5. Automate: the existing `fixed-prefix.test.mjs` size assertion becomes a gate on the real session-start output; `scripts/check-claude-md-size.test.mjs` floor is lowered to the new size so it cannot grow back.

Velocity impact: positive, about 6k tokens per planner turn, more for subagents that inherit `CLAUDE.md`.

## Acceptance Criteria

- [ ] AC-1: `session-start.js` builds its `additionalContext` through `buildFixedPrefix` + `renderFixedPrefix`; the rendered text keeps the governance controls, the role and task frame and the pointers, and the test in `session-start.test.mjs` asserts the output is at most `PREFIX_MAX_BYTES` including the hierarchy role block. The setup warnings and review-policy banner remain, inside the budget.
- [ ] AC-2: The hierarchy role block (`hierarchy-role.js`) includes only the handoff's generated block and its last `## RESUME HERE` block, with a pointer to the full file, so the SessionStart text stays under the budget on a long-lived planner.
- [ ] AC-3: `ai-sdlc-plugin/commands/planner.md` is reduced to the steps and commands (CLI resolution, roster, briefs, decisions, hand-off, handoff routine) with each explanatory paragraph replaced by a one-line pointer into `docs/operations/cli-hierarchy.md` or `docs/operations/decision-authority.md`; target at most 6,000 bytes. The moved prose lands in those docs, not deleted.
- [ ] AC-4: `CLAUDE.md` is reduced to the rules that change behaviour in every session, with reference tables and examples moved to `docs/operations/` and `.claude/rules/*.md` (path-bound); target at most 8,000 bytes, and `scripts/check-claude-md-size.test.mjs` lowers its ceiling to the new size plus 1,000 bytes.
- [ ] AC-5: `pnpm test` and `pnpm test:plugin` pass; `scripts/lint-controls.mjs` still passes; the PR body reports the planner's first-turn context before and after (from `cli-hierarchy status`).

## Notes

Origin: planner context survey 2026-11-01 and operator go at 22:56Z on its three recommendations. Sibling: AISDLC-1151 (launch profile restricting tools and agents per role, the larger lever). RFC-0053 surfacing hooks (AISDLC-779, PR #2255) are in the repo but the installed plugin cache (0.40.0) predates them; enabling them is a plugin version bump through the release PR and is outside this task. When they are enabled, the planner `sessionStart` budget in `.ai-sdlc/context-profiles.yaml` (AISDLC-781) should be set below 3000 so surfacing does not refill what this task removes.
