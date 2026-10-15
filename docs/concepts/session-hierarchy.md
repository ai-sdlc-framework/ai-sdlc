---
title: "Session Hierarchy for Parallel Dispatch"
description: "Three tiers of Claude Code sessions (planner, dispatch, executors) with fixed names and one job each."
---

Three tiers of Claude Code sessions with fixed names and one job each: a planner where backlog work is designed, a dispatch session that owns throughput, and N executors that each run exactly one task at a time. The tiers are peers technically. The hierarchy is a protocol: an authority matrix, a durable assignment channel, an escalation chain that ends at the operator only as a last resort, and a rule that empties an executor's context between tasks.

> **RFC:** [RFC-0051 — Session Hierarchy for Parallel Dispatch](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md) · **Status:** Signed off; roster schema, the bootstrap command and the dispatch brief shipped October 2026 · **Companion:** [RFC-0041 Conductor/Worker](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0041-conductor-worker-process-architecture.md)

## How the operator got here

This RFC codifies the shape the framework's own operator arrived at after trying several parallel-execution patterns on a single machine: one autonomous session doing everything, sibling worker sessions pulling from a board, and N tmux panes each running the execute command. Each worked. Each also lost context, double-dispatched, or stalled on a question only a human could answer, at 3 a.m.

## The three tiers

| Tier | Default model | Owns | Does not do |
|------|---------------|------|-------------|
| **Planner** | Strongest available | RFC walkthroughs, task design, decisions that need judgment | Dispatch or execute |
| **Operator-dispatch** | Mid-tier | Throughput: assignment, rebase, lease-push on a task's own branch, CI retrigger, requeue, filing follow-ups | Design decisions |
| **Executor** (N, five by default) | Cost-efficient | Exactly one execute run at a time | Anything outside its assigned task |

Authority for the dispatch tier's operational actions is granted in policy, so throughput never waits on a typed confirmation. Escalation runs upward: an executor asks dispatch, dispatch asks the planner, the planner runs the decision rubric and records the call in the Decision Catalog, and only an irreversible or operator-reserved question reaches the human.

## What makes it durable

- **Roster.** The bootstrap command starts the tiers in named tmux sessions and writes a roster the tiers use to find each other.
- **Assignment channel.** Assignments survive an executor crash, restart or context clear. A task is never lost because the session that held it went away.
- **Dispatch brief.** Generated from task metadata, with waves and sequence groups, so dispatch knows what can run in parallel and what must wait.
- **Context lifecycle.** An executor is emptied between tasks. Stale context from the previous task does not leak into the next one.
- **Usage by role.** Each tier's consumption is visible in the usage ledger, so the operator can see what the planner, dispatch and each executor cost.

## What this unlocks

- A single operator can run five concurrent executors overnight and wake up to a list of decisions rather than a list of stalls.
- The same protocol scales down to one session wearing all three hats, and up toward the multi-host enterprise scheduler.

## Where to go next

- [Autonomous orchestrator](./autonomous-orchestrator.md) is the dispatch loop each tier is built on.
- [Usage ledger and model routing](./usage-ledger-model-routing.md) supplies the per-role cost view.
