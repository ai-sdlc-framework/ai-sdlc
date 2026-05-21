---
id: AISDLC-382
title: 'fix(hooks): emit hookEventName in session-start + subagent-start hooks'
status: Done
assignee: []
created_date: '2026-05-20'
labels:
  - hooks
  - bug
  - external-contributor-re-implementation
dependencies: []
priority: medium
references:
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/session-start.test.mjs
  - ai-sdlc-plugin/hooks/subagent-start.js
  - ai-sdlc-plugin/hooks/subagent-start.test.mjs
---

## Problem

Two Claude Code hooks (`ai-sdlc-plugin/hooks/session-start.js` and `ai-sdlc-plugin/hooks/subagent-start.js`) do not emit the `hookEventName` field in their hook-event payload. Claude Code's hook protocol expects every payload to include this field so downstream consumers (and the orchestrator's event logger) can dispatch on event type without inferring from context.

Originally identified + implemented by @akillies in PR #568. PR #568 hit cryptographic-trust-chain friction (contentHashV4 mismatch under pull_request_target after rebase) that made the fork-PR path unworkable for this change. Re-implementing via the standard issue-first pipeline. Tracked upstream in issue #584.

## Scope

Mirror akillies's PR 568 approach:

1. `ai-sdlc-plugin/hooks/session-start.js` — add `hookEventName: 'SessionStart'` to the hook-event payload object
2. `ai-sdlc-plugin/hooks/subagent-start.js` — add `hookEventName: 'SubagentStart'` to the hook-event payload object
3. Update co-located test files (`session-start.test.mjs`, `subagent-start.test.mjs`) to assert the new field is present in payloads

## Acceptance criteria

- [ ] #1 `session-start.js` emits `hookEventName: 'SessionStart'` in its hook-event payload
- [ ] #2 `subagent-start.js` emits `hookEventName: 'SubagentStart'` in its hook-event payload
- [ ] #3 `session-start.test.mjs` asserts the field is present + matches `'SessionStart'`
- [ ] #4 `subagent-start.test.mjs` asserts the field is present + matches `'SubagentStart'`
- [ ] #5 All hook tests pass via `pnpm test` (hooks use `node --test` not Vitest)
- [ ] #6 Original commit credited via `Co-Authored-By: Alexander Kline <akillies@users.noreply.github.com>` trailer + PR body acknowledgement of #568

## Out of scope

- Other hook files (only session-start + subagent-start need the field per the original PR's scope)
- Hook contract documentation update (separate concern, file as follow-up if discovered to be needed)
- Investigation of the contentHashV4 mismatch from PR 568 (separate; would become its own backlog task)

## Source

Closed-PR re-implementation. PR #568 by @akillies (closed 2026-05-20), issue #584, operator request 2026-05-20: "just open an issue for the work and do the work."
