---
title: "Workflow engine"
description: "The execute pipeline as a document of nodes and edges, run by default with caps and frozen rules the document cannot loosen."
---

The execute pipeline used to be a hand-written state machine. RFC-0056 expresses it as a workflow document, a set of nodes and edges, and runs it with an engine. The engine is the default: `ai-sdlc-pipeline next-step` uses it with no environment flag.

> **RFC:** [RFC-0056 — Composable Workflow Graph](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0056-composable-workflow-graph.md) · **Status:** Signed Off; phases 1 to 4 shipped · **Runbook:** [workflow-engine](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/workflow-engine.md)

## The document

The built-in `execute-task` document has step nodes (validate, branch, worktree, prompt, parse, plan, aggregate, iterate, finalize, ship, cleanup and others), a `develop` agent node and a `review` fan-out node. An edge from `aggregate` back to `develop` carries the loop cap. `cli-workflow graph` prints it as YAML or Mermaid, and `cli-workflow validate` checks `.ai-sdlc/workflow.yaml`.

## What the engine does

Each call computes the ready set, runs `step` and `anchor` nodes in process and returns the first `agent` or `fanout` node as one spawn instruction. It writes one record per node run into the run state, so a resume replays them. The document is read from the base branch only; a file that exists only in the working tree is ignored, and with none on the base branch the built-in default runs.

It refuses a run before any node starts when the document was not loaded from the base branch, declares an agent as an anchor, has a path to `ship` that crosses no anchor, has an undeclared cycle or an unknown `impl`, or has a fan-out whose `expect` is not `all`.

## Overlays and the frozen set

A document with `metadata.extends: ai-sdlc/execute-task@<version>` is applied over the default. It may add nodes and edges, change `with`, lower caps and loop `max`, and remove non-frozen nodes. It may not touch a frozen node, raise a fan-out cap (4) or loop `max` (2) above the plugin ceiling, loosen `expect`, or remove the last anchor before `ship`. The aggregate node (severity rule, unanimity) and the ship node (never land, lease-only push) are frozen. A frozen entry changes only when `metadata.decisions` names decision ids that resolve on the base branch.

## Non-gating nodes

An agent node with `gating: false` runs beside the gating reviewers. Its report is set aside before the join and written to a comparison ledger, and `sample` limits how often it runs.

## Escape hatch

`AI_SDLC_WORKFLOW_ENGINE=0` selects the legacy machine and prints one deprecation warning per process. Only the exact value `0` does; a run begun on one path cannot be resumed on the other.

## Where to go next

- [Two-tier pipeline](./two-tier-pipeline.md) describes the pipeline the document encodes.
- [Staged review](./staged-review.md) describes the lens a document may keep or drop.
