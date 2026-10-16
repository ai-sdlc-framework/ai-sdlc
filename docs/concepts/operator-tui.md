---
title: "Operator TUI"
description: "A terminal UI for monitoring and steering the autonomous pipeline and answering its open decisions."
---

A terminal UI for monitoring and steering the autonomous pipeline. The operator's job in the framework reduces to a series of decisions; the TUI surfaces those decisions and the data behind them.

> **RFC:** [RFC-0023 — Operator TUI: Pipeline Monitoring + Steering Surface](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md)

## Why a TUI

Operating the framework from a chat window makes you context-switch every time the orchestrator asks for a decision. The TUI keeps everything one keystroke away: pipeline progress, open PRs, the dependency graph, configuration, and recent decision activity. Built with Ink so it runs in any terminal that can render ANSI.

## Panes

| Pane                  | What you see                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| **Pipeline**          | In-flight pipeline runs, current stage per run, recent failures            |
| **PRs**               | Open PRs by branch, CI status, mergeability, attestation state             |
| **Critical path**     | Dependency-graph view showing which tasks unblock the most downstream work |
| **Config**            | Current `.ai-sdlc/*.yaml` files; jump to edit                              |
| **Decisions pending** | Tasks the DoR gate flagged or attestation envelopes that need re-signing   |
| **Analytics**         | Per-stage cost + duration trends, classifier calibration deltas            |

The "Decisions pending" pane is foreground — the framework's whole posture is "operator stays in the loop only when judgment is required," so anything that needs you is surfaced first.

## Activation

```bash
node pipeline-cli/bin/cli-tui.mjs
```

Reads `events.jsonl` (the orchestrator's append-only event log), the `cli-status` poller, the GitHub PR cache, and the dependency snapshot. No new state — the TUI is a view over data the rest of the pipeline already writes.

## Modes

- `Overview` — default; shows all panes
- `deps-full` — full dependency-graph mode (zoom + filter)
- `help` — keybindings reference

## Operator runbook

- [`pipeline-cli/docs/tui.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/docs/tui.md) — full reference
