---
id: AISDLC-1033
title: 'Hierarchy mod phase 0: spike a minimal hooks module (clear, $.store, session.receive, prompt.submit) and measure the saving'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - rfc-0058
  - phase-0
  - spike
  - plugin
dependencies: []
references:
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - pipeline-cli/src/hierarchy/clear.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

RFC-0058 phase 0 (Signed Off 2026-10-22). A one-day spike with no production change that answers the two facts the design depends on and records the measured saving.

**Scope.**
1. A minimal hooks module under `ai-sdlc-plugin/hooks/hierarchy-spike/` (listed in the plugin's hooks manifest `modules` list (`.claude-plugin/plugin.json`, or `hooks/hooks.json` if the Mods loader requires it) only behind an `AI_SDLC_HIERARCHY_SPIKE=1` guard, so no adopter loads it) registering `session.start`, `turn.complete`, `session.measure`, `session.receive` and `session.end`, each appending one JSON line to `.ai-sdlc/hierarchy-spike.log`, plus a `/hier-ping` command that replies with the session id.
2. OQ-1 fact: call `$.command.run({ command: 'clear' })` then `$.prompt.submit({ text: '/hier-ping' })` from the module; record whether the clear runs, whether the module reloads, whether a value written to `$.store` before the clear is readable after it, and whether the prompt starts a turn once the session is idle. If `clear` resolves `{ drop }`, run the same sequence with `$.session.compact` and record the result as the first fallback.
3. Receive fact: from a second session, `$.session.send` to the first by roster name; record that `session.receive` fires before the model sees the text and that returning `{ consumed }` leaves the model silent (no turn in `turn.start`).
4. Measurement: tokens and wall-clock seconds for one mod-consumed message against one model-relayed SendMessage, repeated five times each, written to the log and summarised in the task's PR body.
5. Version: record the Claude Code build the spike passed on (`claude --version`); the RFC's OQ-5 floor is set from it by a follow-up docs edit.
6. Cross-cutting rule (RFC-0058 "Upstream gaps"): any primitive that does not behave as the Mods docs state is written up as an upstream issue draft in the PR body, with the interim workaround named; no heuristic over pane text or processes.

**Five-step review (requirements first).**
1. Requirement questioned: must the design be built before its two load-bearing facts (clear from a mod, consumed receive) are known? No; a day of spike settles both.
2. Delete: nothing to delete in this phase (the spike module is removed by phase 1).
3. Simplify: one module, five hooks, one log file, one command.
4. Accelerate: a hard yes or no on `clear` in a day instead of discovering it in phase 1.
5. Automate: `claude plugin validate` and `claude plugin test` run the spike module in CI behind the env guard.

## Acceptance Criteria

- [ ] The spike module loads with `claude plugin validate` and `claude plugin test` passing, and is not loaded without `AI_SDLC_HIERARCHY_SPIKE=1`.
- [ ] The log records, for `clear`: ran or dropped (with the drop reason), module reloaded yes/no, `$.store` value survived yes/no, `/hier-ping` turn started yes/no; and the same four facts for `compact` when `clear` was dropped.
- [ ] The log records a `session.receive` event with `{ consumed }` returned and no matching `turn.start`.
- [ ] The PR body holds the five-run measurement table (tokens, seconds) for mod-consumed against model-relayed messages, and the Claude Code build string.
- [x] Any primitive gap is written as an upstream issue draft in the PR body with the interim workaround named.
- [x] No production code path changes; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Added the RFC-0058 phase 0 spike mod, inert unless AI_SDLC_HIERARCHY_SPIKE=1, with a Vitest unit test. The live measurements (ACs 2, 3, 4) are not done, because a headless agent cannot run two interactive roster sessions. The draft PR says so.

## Changes
- ai-sdlc-plugin/hooks/hierarchy-spike/.claude-plugin/plugin.json
- ai-sdlc-plugin/hooks/hierarchy-spike/hooks/hooks.json
- ai-sdlc-plugin/hooks/hierarchy-spike/hooks/register.ts
- ai-sdlc-plugin/hooks/hierarchy-spike/commands/hier-ping.md
- ai-sdlc-plugin/hooks/hierarchy-spike/README.md
- ai-sdlc-plugin/mods/tests/hierarchy-spike.test.ts
- backlog/tasks/AISDLC-1033 - hierarchy mod phase 0 spike clear store receive and the measured saving.md

## Design decisions
AC1 is partial. `claude plugin validate` passes on the spike folder. I did not run `claude plugin test` successfully, because the `claude-code/testing` kit API is undocumented, so the tests run under the repo's Vitest instead. The module is a standalone mod folder (not listed in the main plugin manifest) and its register function returns at once without the env guard. ACs 2, 3 and 4 need an operator to run the module in two live sessions: the clear and compact facts, the consumed-receive evidence with no matching turn.start, and the five-run token and second table. The PR body holds empty placeholders for them. The Claude Code build in this environment is 2.1.307; RFC-0058 cites 2.1.304. The PR body has two upstream issue drafts. First, a hooks module cannot import node:fs or pass `$` around, so the spike logs to a `$.store` list as the interim workaround. Second, the `claude plugin test` kit is undocumented.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
- declined: live two-session measurements need an operator-run interactive session; tracked in PR 1913 body

