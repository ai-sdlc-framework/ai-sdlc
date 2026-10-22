---
id: AISDLC-1033
title: 'Hierarchy mod phase 0: spike a minimal hooks module (clear, $.store, session.receive, prompt.submit) and measure the saving'
status: To Do
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
  - ai-sdlc-plugin/hooks/hooks.json
  - pipeline-cli/src/hierarchy/clear.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

RFC-0058 phase 0 (Signed Off 2026-10-22). A one-day spike with no production change that answers the two facts the design depends on and records the measured saving.

**Scope.**
1. A minimal hooks module under `ai-sdlc-plugin/hooks/hierarchy-spike/` (listed in `hooks/hooks.json` `modules` only behind an `AI_SDLC_HIERARCHY_SPIKE=1` guard, so no adopter loads it) registering `session.start`, `turn.complete`, `session.measure`, `session.receive` and `session.end`, each appending one JSON line to `.ai-sdlc/hierarchy-spike.log`, plus a `/hier-ping` command that replies with the session id.
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
- [ ] Any primitive gap is written as an upstream issue draft in the PR body with the interim workaround named.
- [ ] No production code path changes; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
