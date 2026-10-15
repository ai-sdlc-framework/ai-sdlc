---
title: "Staged Review Pipeline"
description: "A staged reviewer pipeline that cuts review cost versus three parallel full-diff reviewers."
---

Three parallel reviewer agents each reading the whole diff was a reasonable first design. It is also three times the strongest model's cost, and each reviewer sees the diff with no shared view of what is risky in it. RFC-0052 replaces that with one review pipeline that assigns each kind of work to the cheapest thing that can do it.

> **RFC:** [RFC-0052 — Staged Review Pipeline](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0052-staged-review-pipeline.md) · **Status:** Signed off October 1, 2026; implementation in progress · **Depends on:** [Judgment layer](./judgment-layer.md), [Proof of Execution](./proof-of-execution.md)

## The stages

1. **Code does what code can decide.** Diff facts, changed symbols, callers, coverage of changed lines. No model call.
2. **The judgment layer classifies.** What the diff touches and how risky each hunk is, as a risk map.
3. **The strongest model writes a short plan** from the risk map and the task's acceptance criteria. Bounded input, bounded output.
4. **Cheaper models execute the plan's probes in parallel.** Read, trace, run, compare. Each returns evidence.
5. **The strong model reads the evidence and writes the verdict.** Every finding cites the probe that produced it.

Some probes are mandatory and no plan can remove them, so a plan-driven review cannot look away from something because the planner did not think of it.

## What stays the same

The verdict envelope, the aggregation, the attestation and the iteration loop are unchanged. The pipeline is a third reviewer set, `staged`, beside the existing `three` and `code-test-merged` sets, selectable per repository.

## How it earns its place

Adoption is decided by replay evidence against the known-defect corpus, under the relax-class bar from RFC-0049 (a judgment that could reduce review needs 95% precision and has no override path). The staged set is not promoted because it is cheaper. It is promoted when the replay shows it catches what the three-reviewer set catches.

## What this unlocks

- One review that reads the diff and its context once, with the expensive model used only where it adds something.
- Findings that are grounded in evidence a probe produced, not in a reviewer's recollection of the diff.
- A measurable path to lower review cost that cannot be taken on assertion.

## Where to go next

- [Cross-harness review](./cross-harness-review.md) describes the independence rule the staged set still has to satisfy.
- [Reviewer independence](./reviewer-independence.md) is the tier the staged verdict is attested under.
