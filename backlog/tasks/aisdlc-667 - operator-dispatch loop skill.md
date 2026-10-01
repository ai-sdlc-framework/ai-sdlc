---
id: AISDLC-667
title: >-
  RFC-0051: /ai-sdlc operator-dispatch loop (brief ingestion, verdict watch, context clears, unblocking playbook, reports)
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
  - plugin
  - skill
  - tmux
dependencies:
  - AISDLC-663
  - AISDLC-664
  - AISDLC-665
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - ai-sdlc-plugin/commands/execute-parallel.md
  - ai-sdlc-plugin/agents/ci-conflict-resolver.md
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The skill the dispatch session runs: it owns throughput. It turns briefs into
manifests, watches verdicts, clears executors between tasks, unblocks what it is
allowed to unblock, and reports upward. RFC-0051 sections 1, 6 and 9.

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
1. **Skill** `ai-sdlc-plugin/commands/operator-dispatch.md`, a wake-up loop in the
   style of `ai-sdlc-plugin/commands/orchestrator-tick.md`:
   - **Ingest:** for each new file in `.ai-sdlc/dispatch/briefs/`, run
     `cli-dispatch enqueue --from-brief` and mark the brief ingested.
   - **Verdict watch:** for each new file in `done/` or `failed/`, record it, then
     clear the executor that produced it (below), then apply the playbook on failures.
   - **Report:** send the planner a progress line at the configured cadence and a
     summary when a brief completes.
2. **Context clear** (`cli-hierarchy clear <executor-name>`): looks up the executor's
   pane in the roster (`{{schemaVersion: 'v1', sessions: [...]}}`; `paneId` matches
   `^%[0-9]+$`, `tmuxSession` is `ai-sdlc-hierarchy`), sends `/clear` followed by Enter, waits for the configured
   settle time, then sends `/ai-sdlc executor` followed by Enter; records an
   `ExecutorContextCleared` event. Refuses when the executor has an inflight
   manifest. Implemented in TypeScript with the tmux calls behind the injectable
   runner.
3. **Unblocking playbook**, each step gated by the `operational` list from
   AISDLC-663 and recorded as an event:
   - PR behind `main` or conflicting on a mechanical shape: rebase the task branch
     onto `origin/main` and `git push --force-with-lease` to that branch only
     (reuse the mechanical-conflict classification from
     `ai-sdlc-plugin/agents/ci-conflict-resolver.md`);
   - CI stuck on a stale merge ref: push an empty commit to the task branch;
   - failed manifest within the retry limit: `cli-dispatch requeue <task-id>`;
   - anything else: escalate (AISDLC-669; until it ships, message the planner with
     the task id and the failure).
4. **Hard rules in the skill body:** never resolve an RFC Open Question; never edit
   `.ai-sdlc/*` policy or a task's acceptance criteria; never merge unless the
   governance policy already permits it; never touch `main`; never answer a `design`
   decision.
5. **Events:** add `HierarchySessionStarted`, `ExecutorContextCleared`,
   `DecisionRouted` to `pipeline-cli/src/orchestrator/events.ts` and the events
   schema (the escalation events are completed in AISDLC-669).
6. **Identity and capability:** every board write by this loop uses the dispatch
   session's roster `name` as `workerId`. Register `hierarchy.clear` (AISDLC-642
   registry): `live` when a clear's second keystroke was sent and the executor
   reported back within the settle time, `degraded` with a reason otherwise. Any new capability id must also be
   added to `KNOWN_CAPABILITY_IDS` in `scripts/check-rfc-docs.mjs`, or the RFC linter
   fails on the `runtimeEvidence` entry that later names it.

## Acceptance Criteria
- [ ] A brief dropped into `briefs/` is enqueued once; a second tick does not enqueue it again.
- [ ] A verdict in `done/` triggers exactly one clear for the executor named in it, and the clear sends `/clear` then `/ai-sdlc executor` to that executor's pane (asserted on the injected runner).
- [ ] `cli-hierarchy clear` refuses an executor with an inflight manifest.
- [ ] A `failed/` diagnostic with a mechanical conflict shape results in a rebase and a lease push to the task branch only; one with an unknown shape results in an escalation and no git action.
- [ ] A failed manifest within the retry limit is requeued; one past it is left in `failed/` and escalated.
- [ ] The playbook never issues a push to `main` or `master` (negative test), and every playbook action is recorded as an event.
- [ ] The three new event types validate against the updated schema.
- [ ] `hierarchy.clear` is listed in `KNOWN_CAPABILITY_IDS` and reported `live` after a successful clear and `degraded` when the executor does not resume within the settle time.
- [ ] The skill body states the hard rules.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
