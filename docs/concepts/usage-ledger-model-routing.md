---
title: "Usage Ledger & Model Routing"
description: "One normalized record for every model call and a routing table mapping agent roles to models."
---

One normalized record for every model call made on the operator's machine, and a routing table that says which model runs which agent role, where every entry cites the evidence behind it. The ledger answers "what did this cost and how much allotment is left". The routing table turns that into a decision about which model to use next time.

> **RFC:** [RFC-0050 — Usage Ledger and Evidence-Based Model Routing](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md) · **Status:** Signed off; ledger, ingesters, reports, allotment tracking, routing table, scorecard and offline replay shipped October 2026; the weekly routing proposal is still planned · **Runbooks:** [usage ledger](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/usage-ledger.md) · [model routing](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/model-routing.md)

## Part A: the ledger

The ledger reads the records the harness already writes. It does not sit in the path of any call. Claude Code and Codex transcripts are ingested first; framework code that calls a model itself reports directly.

Each record holds the model, five token counts (input, two cache-write classes, cache read, output), the agent role that made the call, the task it served and the billing pool it drew from (subscription, agent credit, API key, pay-per-token). From that the framework reports usage per model, role, task and subscription window, and tracks how the allotment changes over time.

**Nothing but counts, ids and attribution is stored.** No prompt, no response, no file content and no tool output is ever read into the ledger. The ledger is machine-level, lives outside any repository and is never committed.

## Part B: evidence-based routing

A repository that does nothing keeps its current defaults. Once it commits `.ai-sdlc/model-routing.yaml` on its base branch, the table decides which model each role gets, keyed by role and task class.

Two mechanisms supply the comparisons a pinned role could never produce:

- **Deterministic exploration.** A configurable share of tasks is routed to a cheaper arm, chosen by a salted hash so the assignment is reproducible and cannot be gamed per task.
- **Offline reviewer replay.** A corpus of past reviews is replayed against candidate models off-peak, within a budget, and scored against known outcomes.

The ledger is joined to outcomes the framework already records (review verdicts, iteration counts) to give quality and cost per role, model and task class. The result is a scorecard, and the routing table changes under an asymmetric rule: cheaper arms must earn their place with evidence; falling back to the stronger model needs none.

The table is read from the base branch only. A pull request cannot route its own development or review to a different model by editing the table in its own diff.

## What this unlocks

- **Operators** on a subscription see where the week's allotment went, by role and task, and stop hitting the quota on Thursday.
- **Teams** get a defensible answer to "could a cheaper model do this role" instead of an opinion.
- **Enterprise fleets** have the per-user, per-role usage record that pacing and chargeback need.

## Where to go next

- [Session hierarchy](./session-hierarchy.md) uses per-role usage from the ledger to size the executor pool.
- [Operator TUI](./operator-tui.md) has a usage pane with the window view and top consumers.
