---
id: AISDLC-1212
title: 'One DAG engine; task-decomposer delegates to dependency-graph'
status: To Do
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
- [ ] #1 A cyclic task graph given to the decomposer throws with the cycle path; no layer output is produced.
- [ ] #2 Decomposer output for an acyclic fixture is unchanged from today (snapshot test).
- [ ] #3 A grep-style test asserts no other topological sort implementation exists outside `dependency-graph.ts` and the RFC-0056 workflow engine.
