---
id: AISDLC-117
title: Compute backlog task dependency graph + integrate into dispatch frontier
status: Done
assignee: []
created_date: '2026-05-01 16:30'
labels:
  - dispatch
  - dependency-graph
  - orchestration
  - tooling
  - observability
dependencies: []
references:
  - backlog/tasks/
  - backlog/completed/
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Today the orchestrator dispatches backlog tasks based on operator instinct ("X needs Y first"). The `dependencies:` frontmatter field on each task encodes the graph but nobody computes it. This has caused real bugs:

- **Duplicate dispatch** (2026-05-01): AISDLC-104 was dispatched as a fresh dev run, but it had already been shipped via PR #116 in a parallel session ~3 hours earlier. The graph computer would have flagged "this task is in `backlog/completed/`" before spawning the dev.
- **Manual dependency tracing**: AISDLC-100.4 needs 100.3 first; 100.8 needs 100.7+100.4; the RFC-0011 Phase 1-9 chain is sequential. Today the operator (or Claude) traces this by reading task descriptions and running ad-hoc grep. A computed frontier would just say "these N are ready, dispatch them."
- **No critical-path visibility**: when planning sprints, no way to know "this 5-task chain blocks 12 downstream items, prioritize the head."

## Why this is high-priority

This isn't a feature; it's missing infrastructure. Every dispatch decision today is a manual graph traversal that gets things wrong. The cost of building this is small (a few hundred lines of TS); the cost of NOT building it compounds with every new task added.

## Bounded scope (this task)

A standalone `cli-deps` CLI + dispatch integration. No PPA composition, no Slack digest, no critical-path scoring — just the ready-to-dispatch frontier + transitive blocker/impact queries + cycle/dangling validation.

## Deferred to follow-up (file separate tasks if needed)

- **PPA composition**: feed dependency depth into PPA priority (a high-PPA task whose blocker is low-PPA should auto-bump the blocker's score)
- **DoR composition**: when an issue is in `Needs Clarification`, surface the blast radius ("this gates 7 downstream tasks") in the DoR comment
- **Slack digest**: weekly "next critical-path items" entry
- **Cross-RFC dependency tracking**: declare RFC-N depends on RFC-M; surface in the RFC index

## Implementation hints

- Task IDs live in `backlog/tasks/` (open) and `backlog/completed/` (closed). The dependency frontmatter is `dependencies: [AISDLC-N, ...]`.
- The graph node = task ID; edge = "X depends on Y" (Y must be Done before X can start).
- Frontier = nodes whose all-outgoing-edges target completed/.
- Cycle detection = standard topo sort; if it terminates with nodes remaining, there's a cycle.
- Dangling refs = dependency IDs not present in either tasks/ or completed/.
- The `pipeline-cli` package is the natural home for the CLI (consistent with `cli-status`, `cli-classifier-feedback`, etc. patterns from RFC-0010).

## Why bounded vs RFC

Bounded scope here unblocks the immediate pain (dispatch accuracy). The deeper compositions (PPA-aware priority, DoR blast-radius, etc.) deserve their own RFC because they touch multiple existing systems. Ship the foundation, then design composition on top.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `cli-deps frontier` lists task IDs whose dependencies are ALL in `backlog/completed/` (→ ready-to-dispatch). Output formats: human table + JSON.
- [ ] #2 `cli-deps blockers <task-id>` walks the transitive dependency closure and lists every open task that gates the target.
- [ ] #3 `cli-deps impact <task-id>` walks the reverse-edge closure and lists every task that would unblock if the target closes (useful for prioritization).
- [ ] #4 `cli-deps validate` detects cycles in the graph AND flags dangling references (dependencies pointing at non-existent task IDs).
- [ ] #5 `cli-deps graph` emits the graph in mermaid OR DOT for human inspection.
- [ ] #6 Orchestrator dispatch loop in `ai-sdlc-plugin/commands/execute.md` AND `/loop /ai-sdlc execute` consults `cli-deps frontier` before picking next candidate — no more dispatching tasks whose dependencies haven't merged.
- [ ] #7 Pre-flight check in `/ai-sdlc execute <task-id>` refuses to start a task whose dependencies aren't all Done, with a clear error linking to the blocker(s).
- [ ] #8 New code reaches 80%+ patch coverage; tests cover: empty graph, single chain, diamond fan-out, cycle detection, dangling refs, missing-dep refusal.
- [ ] #9 Documentation in `pipeline-cli/docs/dependency-graph.md` explaining the model + CLI usage.
- [ ] #10 Optional Phase 2 (filed as separate follow-up if needed): PPA-aware critical-path scoring + Slack digest integration + DoR refusal blast-radius surfacing.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Built the cli-deps dependency-graph foundation in pipeline-cli: pure DependencyGraph builder + 6 subcommands (frontier|blockers|impact|validate|graph|preflight). Integrated preflight gate into ai-sdlc-plugin/commands/execute.md Step 1.5 — orchestrator now refuses to dispatch tasks whose dependencies aren't all Done.

## Verification
- pnpm build && pnpm test && pnpm lint && pnpm format:check — clean (pipeline-cli 274/274)
- Coverage: dependency-graph.ts 99.03%; deps.ts 98.24%
- 3 reviews APPROVED: code 0c/0M/1m/2s; test 0c/0M/3m/0s; security 0c/0M/0m/0s

## Catches the AISDLC-104 duplicate-dispatch class of bug at source.

## Follow-up (deferred per RFC-0014)
- PPA composition (depth-aware priority)
- DoR composition (blast-radius surfacing)
- Slack digest integration
- Cross-RFC dependency tracking
<!-- SECTION:FINAL_SUMMARY:END -->
