---
title: "Autonomous orchestrator"
description: "How the orchestrator dispatches AI coding agents end-to-end against the dependency-ready frontier of work."
---

The autonomous orchestrator dispatches AI coding agents end-to-end against the dependency-ready frontier of work. Operators tell it which task families it's allowed to pick from; it decides which task to ship next, allocates an isolated worktree, runs the pipeline, opens the PR, and surfaces decisions when human judgment is required.

> **RFC:** [RFC-0015 — Autonomous Pipeline Orchestrator](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md)
>
> **Operational runbook:** [`docs/operations/orchestrator-promotion.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/orchestrator-promotion.md)
>
> **CLI docs:** [`pipeline-cli/docs/orchestrator.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/docs/orchestrator.md)

## Why it exists

Every dispatch the operator makes by hand is a context switch. Picking the next ready task, opening a worktree, dispatching a developer subagent, watching for review feedback, signing the attestation — all of that is mechanical when the **dependency graph** + the **Definition-of-Ready gate** have already done the judgment work upstream. The orchestrator wraps that mechanical loop.

## How it works

The orchestrator is a tick loop:

1. **Frontier**: read the dispatchable frontier from `cli-deps frontier` (tasks whose dependencies are all complete and that pass the [DoR gate](./dor-gate.md)).
2. **Admit**: filter out tasks marked `dispatchable: false`, in flight in another worktree, or operator-blocked.
3. **Dispatch**: allocate a worktree, write the active-task sentinel, fan out to a `developer` subagent.
4. **Pipeline**: the developer runs the [two-tier pipeline](./two-tier-pipeline.md) — implement, lint, test, review fanout, attestation sign, push, open PR.
5. **Re-tick**: on completion (success / failure / human-attention), record the outcome to `events.jsonl` and tick again against the new frontier.

## Activation

The orchestrator is **off by default**. Opt in with:

```bash
export AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental
node pipeline-cli/bin/cli-orchestrator.mjs start
```

`status`, `tick`, and `start` are the three subcommands. See `cli-orchestrator --help` for flags (`--max-ticks`, `--tick-interval-sec`, `--dry-run`).

## When to use it

- You have a populated backlog with declared dependencies.
- You've signed off the DoR config (operator stays in the loop only when the gate flags ambiguity).
- Your subscription / API budget can absorb the dispatch rate (set `--max-concurrent` accordingly).

## When NOT to use it

- You're iterating on a single task in a tight loop — `/ai-sdlc execute <task-id>` is more direct.
- You haven't tuned the DoR gate yet — without it, the orchestrator dispatches half-baked tasks and burns budget.
