---
id: AISDLC-664
title: >-
  RFC-0051: hierarchy roster schema and cli-hierarchy up/status/down bootstrapping named tmux sessions per role
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
  - cli
  - tmux
  - plugin
dependencies: []
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/commands/execute-parallel.md
  - pipeline-cli/src/dispatch/sessions.ts
  - pipeline-cli/src/dispatch/session-reaper.ts
  - pipeline-cli/src/cli/bin-invocation.test.ts
  - docs/operations/parallel-dispatch.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
One command that starts the planner, the dispatch session and N executors as named,
model-pinned, permission-mode-pinned Claude Code sessions in tmux, and a roster file
the tiers use to find each other. RFC-0051 sections 2, 3 and 10.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages; `node --test`
  for plugin hooks and scripts; 80% line coverage on new code.
- Tests never start a real Claude Code session, never call tmux against the user's
  real server (inject the command runner), and never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Roster schema** `spec/schemas/hierarchy-roster.v1.schema.json`: one entry per
   session with `role` (`planner`, `operator-dispatch`, `executor`), `name`,
   `tmuxSession`, `tmuxWindow`, `paneId`, `pid`, `model`, `permissionMode`,
   `startedAt`, `status`. Written to `.ai-sdlc/dispatch/hierarchy.json`. Register
   with AJV and regenerate generated schemas.
2. **Session commands.** For each role the bootstrap runs
   `claude --name <name> --model <model> --permission-mode <mode> "<initial prompt>"`
   in its own tmux window of the session `ai-sdlc-hierarchy`:
   - planner: `--permission-mode` taken from the operator's current setting (not
     forced), initial prompt `/ai-sdlc planner`;
   - operator-dispatch: `bypassPermissions`, initial prompt `/ai-sdlc operator-dispatch`;
   - executors `executor-alpha` through the Nth Greek letter: `bypassPermissions`,
     initial prompt `/ai-sdlc executor`.
   Reuse the task-id and name validation, the resource gate and the spawn pattern
   from `ai-sdlc-plugin/commands/execute-parallel.md`, moved into TypeScript under
   `pipeline-cli/src/hierarchy/` with the tmux and `claude` invocations behind an
   injectable command runner.
3. **`cli-hierarchy up`** with `--executors <n>` (default 5, max 5),
   `--planner-model`, `--dispatch-model`, `--executor-model` (defaults `fable`,
   `opus`, `sonnet`), `--no-planner`, `--attach`. Idempotent: an existing window for a
   role is left alone and reported. Refuses a second planner. After each start, reads
   the harness session registry to learn the name the session actually received (a
   collision adds a suffix) and writes that name to the roster.
4. **Preflight:** checks that the settings in force for the dispatch and executor
   sessions include `crossSessionInbound: "accept"`, and prints the exact settings
   change if not; refuses to start executors without it.
5. **`cli-hierarchy status`:** the roster joined with the harness session registry
   (alive, idle or busy) and with the board's `inflight/` view.
6. **`cli-hierarchy down [--role <name>]`:** sends each session a graceful exit,
   returns its inflight manifest to `queue/`, closes its window and removes it from
   the roster.
7. **Bin shim** `pipeline-cli/bin/cli-hierarchy.mjs`, covered by the bin-invocation
   test.

## Acceptance Criteria
- [x] `cli-hierarchy up --executors 2` with an injected runner issues one tmux window and one `claude` command per role with the specified name, model and permission mode, and writes a roster that validates against the schema.
- [x] A second `up` on a running hierarchy starts nothing new and reports the existing windows.
- [x] A name collision reported by the harness registry (suffixed name) is written back to the roster.
- [x] `up` refuses when `crossSessionInbound` is not `accept` for the bypass tiers and prints the settings change.
- [x] `up` refuses a sixth executor and refuses a second planner.
- [x] `status` prints every roster entry with its live state and inflight task from fixtures.
- [x] `down --role executor-beta` returns that executor's inflight manifest to `queue/`, closes only its window and removes only its roster entry.
- [x] The roster schema is registered and `pnpm validate-schemas` passes.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added the hierarchy roster schema and `cli-hierarchy up|status|down`, which starts the planner, the dispatch session and up to five executors as named, model-pinned, permission-mode-pinned Claude Code sessions in the `ai-sdlc-hierarchy` tmux session and records them in `.ai-sdlc/dispatch/hierarchy.json`. All nine acceptance criteria have tests.

## Changes
- `spec/schemas/hierarchy-roster.v1.schema.json`, registered with AJV in `reference/src/core/validation.ts`, with `generated-schemas.ts` regenerated.
- `pipeline-cli/src/hierarchy/` (roster, registry, preflight, tmux, inflight, up, status, down, system runner), `pipeline-cli/src/cli/hierarchy.ts`, the `cli-hierarchy` bin shim and its bin-invocation test.
- `.gitignore`: the roster file and its temp files.

## Design decisions
- Roster shape is `{schemaVersion, sessions[]}`, validated on every read and write. A tolerant reader skips and reports invalid or foreign entries so `down`, `status` and `up` never act on them.
- `down` acts only on entries in the `ai-sdlc-hierarchy` session, checks that a recorded pane still belongs to the roster window before sending keys, and otherwise targets the window by name. This came from the security review of the first version, which found that an unvalidated roster could make `down` close windows it did not create.
- The planner takes its permission mode from the operator's settings and refuses bypass unless `--allow-planner-bypass` is given; the dispatch and executor sessions start only after the settings preflight and the resource gate pass.
- Inflight joins match the heartbeat worker id to the roster name only; collision-suffixed names must match the requested name plus a numeric suffix.
- The exact JSON for the cross-session inbound setting was verified only against the Claude Code changelog, not official docs; the preflight prints the setting shape the RFC specifies.
- The task's prompts name skills that do not exist yet.

## Verification
- `pnpm build` — passed
- `pnpm test` — hierarchy and cli tests passed (60), orchestrator CLI test passed (32), full reference suite passed (1502); the early root-chain gates (docs, rfc, drift, dark-code, DoR, follow-up and others) pass locally. Seven bin-invocation and verify-runtime tests and six TUI tests fail identically on a clean main checkout.
- `pnpm lint` — passed
- `pnpm format:check` — passed on touched files
- `pnpm dark-code:check` and `pnpm validate-schemas` — passed
- 3 parallel reviews approved after two rounds (Claude-native reviewers); the reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-664.1: document cli-hierarchy and mark execute-parallel superseded.
- AISDLC-664.2: executor and dispatch loops set the heartbeat worker id to their session name.
- AISDLC-664.3: attribute main-session usage to roster roles.
- AISDLC-664.4: emit the session-started event.
- AISDLC-664.5: managed-settings preflight, stuck starting entries, roster name hardening.
<!-- SECTION:FINAL_SUMMARY:END -->
