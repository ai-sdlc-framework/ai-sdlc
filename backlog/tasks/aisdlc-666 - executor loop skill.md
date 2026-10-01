---
id: AISDLC-666
title: >-
  RFC-0051: /ai-sdlc executor loop (claim, execute, verdict, status, wait for clear) and SessionStart clear re-injection
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
  - plugin
  - skill
dependencies:
  - AISDLC-664
  - AISDLC-665
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/commands/dispatch-worker.md
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/hooks/session-start.js
  - pipeline-cli/src/dispatch/board.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The skill each executor session runs for its whole life: claim a manifest, run
`/ai-sdlc execute` unmodified, report, then wait to be cleared. RFC-0051 sections 5
and 9.

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
1. **Skill** `ai-sdlc-plugin/commands/executor.md`, modelled on
   `ai-sdlc-plugin/commands/dispatch-worker.md` but running the full
   `/ai-sdlc execute <task-id>` rather than the developer agent alone:
   1. read the roster (`.ai-sdlc/dispatch/hierarchy.json`, shape
      `{{schemaVersion: 'v1', sessions: [...]}}` from AISDLC-664) to learn this
      session's name and the dispatch session's name; the session's name is the one
      the harness reports, which may carry a collision suffix;
   2. claim the next eligible manifest through `cli-dispatch claim --worker <name>`,
      passing the roster name exactly: the roster's status and down commands join
      inflight manifests to sessions by `workerId` equal to `name`;
      when none is eligible, wait on the configured interval and try again;
   3. run `/ai-sdlc execute <task-id>` with no changes to that command;
   4. write the verdict to `done/` or a diagnostic to `failed/` through
      `cli-dispatch complete`, carrying the pipeline outcome, PR number, follow-up
      task ids and decision ids raised;
   5. send `operator-dispatch` one status line (task, outcome, PR, decision ids);
   6. stop and wait: the next turn arrives after the dispatch session clears this
      session's context and re-issues `/ai-sdlc executor`.
2. **Hard rules in the skill body:** never message another executor; never answer a
   decision; never file a top-level task id, only sub-ids of the current task
   (`<task-id>.<n>`, next free `n` from the board and the backlog); never edit RFC
   Open Questions; a blocking question goes through `cli-decisions escalate` with
   `--route` (the full flow is AISDLC-669; until it ships, escalate with the existing
   command and stop).
3. **Hook:** `ai-sdlc-plugin/hooks/session-start.js` on matcher `clear`, when the
   session's name is in the roster, injects a short role block (role, name, dispatch
   session name, the skill to run) so the emptied context knows what it is.
4. **Sub-id allocation** helper used by the skill: `cli-dispatch next-subid <task-id>`
   scanning `backlog/`, the board and open PR file lists.
5. **Docs** section in `docs/operations/parallel-dispatch.md` describing the loop.

## Acceptance Criteria
- [ ] With a fixture board holding one eligible manifest, the skill's claim step produces an inflight manifest whose `workerId` equals the session's roster `name` exactly.
- [ ] The skill invokes `/ai-sdlc execute <task-id>` with no additional arguments and no modification to `execute.md`.
- [ ] `cli-dispatch complete` writes a verdict containing outcome, PR number, follow-up ids and decision ids, and moves the manifest to `done/` or `failed/` accordingly.
- [ ] The `SessionStart` hook injects the role block only on matcher `clear` and only for a session named in the roster; other sessions see no change (hermetic `node --test`).
- [ ] `cli-dispatch next-subid AISDLC-629` returns the first id not present in the backlog, the board or open PR file lists (fixture).
- [ ] The skill body states the hard rules (no executor-to-executor messages, no decision answering, sub-ids only, no OQ edits).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
