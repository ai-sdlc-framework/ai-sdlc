---
id: AISDLC-1034
title: 'Hierarchy mod phase 1: executor role (consumed enqueue, prompt.submit wake, clear > compact > relaunch rotation); executor-start loses --wait, the token and sender flags'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - rfc-0058
  - phase-1
  - plugin
  - hierarchy
dependencies:
  - AISDLC-1033
references:
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/hierarchy/executor-start.ts
  - pipeline-cli/src/hierarchy/start-token.ts
priority: high
dispatchable: true
---

## Description

RFC-0058 phase 1 (Signed Off 2026-10-22). The `hierarchy` hooks module ships in the ai-sdlc plugin (OQ-2) with the executor role only; the spike module is removed.

**Scope.**
1. `ai-sdlc-plugin/hooks/hierarchy/register.tsx` exported `register(on, options)`; the plugin's hooks manifest lists it under `modules`. At `session.start` it reads the role from `hierarchy.json` or `HIERARCHY_ROLE` exactly as `hierarchy-role.js` does and returns without registering anything when no role is set.
2. OQ-5 guard: before registering, compare `$.session.version()` with the floor recorded by the phase 0 spike and probe every primitive the role uses (`prompt.submit`, `command.run`, `session.compact`, `session.measure`, `session.send`); on a miss register nothing and log one line naming the missing primitive and the floor.
3. OQ-4 probe: when `$.session.identity()` answers, record it as an informational field in the start line beside the role and the detected tier; never use it as authority.
4. Executor role: `session.receive` consumes an enqueue message from the dispatch roster name and calls `$.prompt.submit({ text: '/ai-sdlc:executor' })`; status noise is consumed; anything else passes through. After the verdict (`turn.complete` of the task's last step, never mid-task) the module rotates per OQ-1: handoff write, `$.command.run('clear')` with `$.store` carrying role, resume command and last reply; on `{ drop }`, `$.session.compact` with the hierarchy summary prompt; on a second failure, end the session for `cli-hierarchy up`. `session.measure` triggers the same rotation at 120k tokens.
5. `executor-start` keeps its claim semantics and loses `--wait`, the start token and the sender flags; the board claim is the authority (RFC-0051). Delete `start-token.ts` and its tests; the executor command drops the background `--wait` pattern.
6. Backward compatibility: a tmux-driven dispatch session can still enqueue for a mod-driven executor because both read the same board.

**Five-step review (requirements first).**
1. Requirement questioned: does an executor need an outside process to type its resume? No; a mod inside the session can submit the prompt once idle.
2. Delete: `start-token.ts`, `executor-start --wait`, the executor's sender flags and the spike module.
3. Simplify: one `register` entry point, role read once, one rotation function with a fixed fallback order.
4. Accelerate: a wake is a consumed message plus `prompt.submit`, not a 30 s pane poll and typed keys.
5. Automate: `claude plugin test` fixtures for no-role, version-miss, consumed enqueue, rotation with clear, rotation with compact fallback.

## Acceptance Criteria

- [ ] `claude plugin validate` and `claude plugin test` pass; with no role set the module registers no hook (test).
- [ ] A version or primitive miss registers nothing and logs the missing primitive and the floor (test per probed primitive).
- [ ] An enqueue message from the dispatch roster name is consumed (no model turn) and starts `/ai-sdlc:executor` once idle (test with a fake `$.prompt.submit`).
- [ ] Rotation runs handoff write, then clear with `$.store` carrying role, resume command and last reply; on `{ drop }` it compacts; on a second failure it ends the session (three tests).
- [ ] Rotation never fires mid-task: a `session.measure` over threshold during a task waits for the task's last `turn.complete` (test).
- [ ] `executor-start` has no `--wait`, token or sender flag; `start-token.ts` is deleted; `pnpm dark-code:check` passes without baseline growth.
- [ ] `docs/operations/cli-hierarchy.md` describes the executor role of the module and the removed flags.
