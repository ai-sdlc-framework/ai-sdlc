---
title: "Definition-of-Ready gate"
description: "A pre-execution gate that refuses to dispatch tasks the operator has not yet decided."
---

A pre-execution gate that refuses to dispatch tasks the operator hasn't actually decided yet. Instead of guessing — and producing a half-right PR that costs more to review than to write from scratch — the gate collects the open questions and routes them back to the operator.

> **RFC:** [RFC-0011 — Definition-of-Ready Gate for Pipeline Admission](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0011-definition-of-ready-gate.md)

## Why it exists

The autonomous orchestrator picks the next task off the dependency-ready frontier. "Ready" in the dependency sense means "all upstream tasks merged." That's necessary but not sufficient. A task can have all its dependencies satisfied AND still be a bad dispatch candidate because:

- the acceptance criteria are vague
- a key API decision was deferred to a comment that nobody resolved
- the task description references a doc that was renamed
- the task is actually two tasks pretending to be one

The DoR gate runs a configurable rubric against every candidate task. Tasks that don't pass don't get dispatched — and the operator gets a structured `Needs Clarification` comment naming the failed gates.

## How it works

1. **Stage A (deterministic)**: cheap rules — does the task have at least one acceptance criterion, are all references resolvable, is the description ≥ N characters, etc.
2. **Stage B (semantic)**: an LLM evaluator (`refinement-reviewer`) scores semantic gates Stage A can't decide — "is the AC actually verifiable?", "does this task overlap with task #N already in flight?".

The combined verdict is `passed` / `needs-clarification` / `blocked`. The orchestrator skips anything that isn't `passed`.

## Operator workflow

When the gate flags a task:

1. The task gets `status: Needs Clarification` and a comment with the failed gates + suggested edits.
2. You edit the task to address the gaps (or close it if it was a bad idea).
3. Run `node pipeline-cli/bin/cli-dor-check.mjs --task <path>` (or wait for the auto-recheck on body edit).
4. If the gate passes, the orchestrator picks it up on the next tick.

## Configuration

DoR rules live in `.ai-sdlc/dor.yaml` (initialized by `ai-sdlc init --with-dor`). Each rule has a name, severity, and either a deterministic predicate or a semantic prompt. Calibration is per-project — you tune the gate to the patterns your tasks actually exhibit.

## Calibration log

Every Stage B evaluation is logged to `$ARTIFACTS_DIR/_dor/calibration.jsonl`. The `cli-dor-stats` command summarizes false-positive / false-negative rates so you can tighten the rubric over time.

## Operator runbook

- [`docs/operations/dor-promotion.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/dor-promotion.md) — promoting the gate from advisory → required.
