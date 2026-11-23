---
title: "PR lifecycle"
description: "A reconciler that takes a task's pull request from ready to merged, one classified state and one action at a time."
---

A task's work is not done when the executor opens a pull request. It is done when the pull request merges. Between those two points the PR can fall behind, go red, lose its review or stall, and a model that watches PRs on a timer reacts slowly and unevenly. RFC-0054 moves that watching into code: a reconciler classifies each open PR into one state and runs the one action that state names.

> **RFC:** [RFC-0054 — PR Lifecycle as Event-Driven Dispatch](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md) · **Status:** Signed Off · **Runbook:** [cli-hierarchy](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/cli-hierarchy.md)

## How a pass works

`cli-dispatch reconcile` lists the open PRs, classifies each one, writes a record at `landing/<pr>.json` under the board and runs the action for that state. A pass is idempotent: facts that match the stored state, action, head SHA and owner change no file and run no action. A PR whose record shows it merged is marked `landed`.

The classifier is a pure function over GitHub facts. A PR that fits no row classifies as `no-match`, the one state routed to the planner. A green, clean, unarmed ready task PR is the exception: the reconciler arms it.

## The states and what runs

| State | Action for a task PR |
|-------|----------------------|
| `merged` | `mark-landed` |
| `behind-or-dirty` | `reenter` rebases a BEHIND PR; a DIRTY one goes to an executor |
| `needs-re-review` | `review-resume` |
| `real-failure` | `reenter`, with the failing line as a note |
| `cancelled-or-infra` | `retrigger-once` |
| `rate-limited` | `wait-and-rerun` |
| `ready-to-flip` | `flip-ready-takeover`, after executor death |
| `armed-clean`, `pending` | `none` |

A docs PR uses its own set: `behind-or-dirty` runs `rebase-in-place` and a red PR goes to the planner.

## Ownership and the record

The record holds the PR number, kind, task id, owner, state, action, head SHA, failing line and a history of changes. The owner is the executor until the PR is delivered (non-draft and armed), then the machine. Only landing, which means merged, writes the task to `done/`.

## Bounds

- **Same-head guard.** The same action on the same head SHA runs at most `loopGuard.maxSameHeadActions` times (default 1); the next time the PR goes to the planner.
- **CI rounds.** A failed `ai-sdlc/pr-ready` check on a delivered task PR starts a developer round. `loopGuard.maxCiRounds` (default 3) caps the rounds, then the PR goes to the planner.
- Both limits come from `.ai-sdlc/pr-lifecycle.yaml` on the base branch, so a PR cannot loosen them for itself.

## When it runs

A pass runs at start, shortly after the webhook receiver touches the wake file, and on a timer: 60 seconds while task or docs PRs are open, 15 minutes otherwise. The receiver is local, binds to `127.0.0.1`, checks the HMAC signature and writes an event record only; it never classifies or acts. Without `AI_SDLC_WEBHOOK_SECRET` the receiver stays off and the timer still runs. Each dispatch tick lands eligible PRs, then runs one reconcile pass, then spawns executors, so a repair is spawned ahead of new tasks.

## Where to go next

- [Session hierarchy](./session-hierarchy.md) describes the dispatch tick that runs the pass.
- [Proof of Execution](./proof-of-execution.md) describes the verdict record behind `needs-re-review`.
