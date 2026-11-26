---
id: AISDLC-1441
title: "Measure the process-spawn and machine-load cost of our tooling (evidence for or against a rewrite of our CLI)"
status: In Progress
priority: medium
labels:
  - observability
  - performance
dependencies: []
references:
  - pipeline-cli/src/hierarchy/gh-calls.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - backlog/completed/AISDLC-1379 - dispatch polls on the RFC-0054 slow interval while the webhook is healthy.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator direction 2026-11-26. The operator is considering rewriting underlying tech (for example in Rust) and needs evidence first. The only data point today is anecdotal: AISDLC-1379 noted a short-lived `node` and `gh` process per call on a machine at load 15-21. A rewrite of our own CLI cannot change GitHub's server-side limits, so the question this task answers is narrower: how much CPU, wall time and machine load do our own processes (node CLIs, `gh` spawns, hooks, git) cost during a normal drain, and how much of that is process startup versus work. Output is a measurement report escalated to the operator, not a change.
2. Delete: nothing.
3. Simplify: sample, do not instrument everything. Over a 24 h normal drain: count process spawns by executable and parent (node CLI entry, `gh`, `git`, hook scripts), measure per-spawn wall and CPU time, and record system load average; separately benchmark startup cost of `node pipeline-cli/bin/<cli>.mjs --help`, `gh --version` and an equivalent no-op compiled binary on this machine.
4. Accelerate: none.
5. Automate: a script under `scripts/` that produces the report so it can be rerun later, for example once the call-volume work lands.

## Acceptance Criteria
- [ ] #1 A report (doc under `docs/operations/` or an attached artifact) gives, for a 24 h drain: spawns/hour by executable, total CPU seconds and wall seconds by executable, the share spent in process startup, and load-average distribution, with the method stated.
- [x] #2 Startup benchmarks (median of 20 runs) for a node CLI entry, `gh`, and a compiled no-op binary on the operator machine are in the report.
- [x] #3 The report states what fraction of the load a faster-starting implementation could remove at most, and what remains (GitHub latency, git, model sessions), and is escalated to the operator under `dependency-limit:` or as a planner question (no build work follows without an operator decision).
- [x] #4 The measurement script is rerunnable and documented; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
