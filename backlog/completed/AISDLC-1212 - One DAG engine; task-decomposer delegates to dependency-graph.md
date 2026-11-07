---
id: AISDLC-1212
title: 'One DAG engine; task-decomposer delegates to dependency-graph'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - dependency graph
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - orchestrator/src/task-decomposer.ts
  - pipeline-cli/src/deps/dependency-graph.ts
priority: medium
dispatchable: true
---

## Description

**Source.** RFC-0062 Phase 1 item 3. Affected surface: `orchestrator/src/task-decomposer.ts` (`topologicalSort` without cycle detection, `validateTaskGraph` at about V×(V+E), `getExecutionLayers` silently dropping nodes on a cycle) and `pipeline-cli/src/deps/dependency-graph.ts`, which already has iterative cycle detection with path reporting.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* One graph walk with cycle reporting is the requirement; eight walks are not.
2. *Delete.* The private sort, validation and layering in `task-decomposer.ts`.
3. *Simplify.* Delegate to `dependency-graph.ts`; a cycle is an error carrying the path, never a silently dropped node.
4. *Accelerate.* Validation becomes linear in V+E through the shared engine.
5. *Automate.* A test for the cycle path error and a dark-code check that no second topological sort remains outside `dependency-graph.ts` and the RFC-0056 Kahn sort.

## Acceptance Criteria
- [x] #1 A cyclic task graph given to the decomposer throws with the cycle path; no layer output is produced.
- [x] #2 Decomposer output for an acyclic fixture is unchanged from today (snapshot test).
- [x] #3 A grep-style test asserts no other topological sort implementation exists outside `dependency-graph.ts` and the RFC-0056 workflow engine.

## Final Summary

## Summary
The task decomposer now delegates to the single DAG engine in dependency-graph.ts. A cyclic task graph throws with the cycle path and produces no layers. The orchestrator gained a workspace dependency on pipeline-cli. A snapshot test covers acyclic output, and a grep-style test checks that no other topological sort exists.

## Changes
- orchestrator/src/task-decomposer.ts
- orchestrator/src/task-decomposer.test.ts
- orchestrator/src/single-dag-engine.test.ts
- orchestrator/package.json
- pipeline-cli/src/deps/dependency-graph.ts
- pipeline-cli/src/deps/dag-engine.test.ts
- pnpm-lock.yaml

## Design decisions
I rebased onto origin/main and force-pushed with lease. I added a follow-up commit that trims the lockfile diff to just the orchestrator importer link, because the earlier commit had also dropped the optional @next/swc packages. The pre-push hook ran the test suite and passed. I did not run build, lint or format:check myself in this session, so the pipeline's own re-run is the check for those. PR #2474 was already open and is not a draft, so I did not run `gh pr ready`.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

