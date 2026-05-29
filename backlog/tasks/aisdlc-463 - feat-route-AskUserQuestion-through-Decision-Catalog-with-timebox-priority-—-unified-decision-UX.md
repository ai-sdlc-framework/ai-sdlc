---
id: AISDLC-463
title: >-
  feat: route AskUserQuestion through Decision Catalog with timebox + priority —
  unified decision UX
status: To Do
assignee: []
created_date: '2026-05-28 19:18'
labels:
  - feature
  - decision-catalog
  - ux
  - operator-time
  - rfc-0035-extension
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-05-28 during AISDLC-462 design conversation. Operator vision (verbatim):

> "For the AskUserQuestion what we should do is instead of surfacing questions using the AskUserQuestion tool what we should do is route them through the DecisionCatalog with a timebox on them, this way we have a unified interface to surface decisions to the user and prioritize them so the users time is maximally spent on the questions with the highest impact, and the decisions that could be answered autonomously are."

## Problem

Today the framework surfaces operator decisions through two disconnected channels:

1. **AskUserQuestion** (in-conversation, interrupt-driven) — fires immediately, blocks the current agent, no priority signal, no timebox, no record after dismissal
2. **Decision Catalog (RFC-0035)** — async, prioritized, audited, but a separate filing flow most subagents don't use

The mismatch: operator gets interrupted by trivial AskUserQuestions (e.g., "which file naming convention should I use") at the same urgency as load-bearing architectural decisions. Meanwhile, the Decision Catalog — which DOES have timebox + scope + ranking — is underused because AskUserQuestion is the path of least resistance.

## Operator's vision

Treat the Decision Catalog as the **canonical inbox** for all operator decisions. Every place that today fires AskUserQuestion should instead:

1. File a Decision Catalog entry with priority + timebox + autonomous-resolution-hint
2. Optionally surface the highest-priority N decisions in-session (TUI-style ranked queue)
3. Allow the framework to **auto-resolve** decisions whose timebox expires AND whose autonomous-resolution-hint is satisfied (e.g., "use the recommended option if no operator response within 4hrs")
4. Operator interacts with the queue, not individual interrupts — sees decisions ranked by impact × urgency

## Design sketch

### Decision filing API extension

Extend `cli-decisions add` with new fields:

```bash
cli-decisions add \
  --summary "<one-line>" \
  --scope <area> \
  --option "<id>:<description>" \
  --priority critical|high|medium|low \
  --timebox-hours <N> \
  --autonomous-fallback <option-id>   # auto-pick this option on timebox expiry
  --impact-score <0-100>              # for ranking
  --context-ref <pr-or-task>          # backlink to surfacing context
```

### AskUserQuestion-replacement helper

A new `decision-queue` skill or `cli-decisions ask` subcommand that wraps:

1. File the decision via cli-decisions add (with timebox + priority + autonomous fallback)
2. If operator is actively in-session AND priority >= medium: surface inline via existing AskUserQuestion as a courtesy preview
3. If operator is away OR priority = low: just file + log; let the queue handle it

### Queue surface

- `cli-decisions list --ranked` — shows pending decisions ordered by `priority × impact × urgency-decay`
- `cli-decisions resolve <id> --option <id>` — operator resolves a queued decision
- `cli-decisions auto-expire` — daemon (cron or pipeline tick) that picks autonomous-fallback when timebox expires
- TUI extension: new "Decisions" pane in `cli-tui.mjs` showing ranked queue

### Audit trail

Every decision (operator-resolved OR auto-expired) writes a Decision Catalog event with:
- Who resolved (operator-id OR "auto-expired")
- What option chosen
- Why (operator rationale OR "fallback after Xhr timebox")
- Surfacing context (which agent / task surfaced the question)

## Why this matters now

Three converging signals:

1. **RFC-461 (distributed scheduler)** vision includes "operator decision queue ranked by impact × subscription burn-rate" — same idea, scoped to scheduling
2. **AISDLC-462 (tmux N-pane wrapper)** will spawn 5 concurrent sessions, each potentially firing AskUserQuestion — operator interrupt-spam is about to multiply 5x
3. **Operator decision fatigue** is a recurring pattern (memory: `feedback_decision_fatigue_signal`) — the framework already has the substrate (Decision Catalog) to prevent it; just needs to be the default

This task makes the Decision Catalog the framework's actual decision UX, not just an optional escape hatch.

## Out of scope (defer)

- ML-based priority/impact scoring (manual hints first; learned weights later)
- Cross-org decision sharing (single-operator first)
- Slack/email notification fan-out (Decision Catalog → external)
- Voice/conversational decision UX

## References

- spec/rfcs/RFC-0035-decision-catalog-operator-routing.md — existing catalog substrate
- pipeline-cli/src/cli/decisions.ts — current `cli-decisions` implementation
- feedback_decision_fatigue_signal — memory of operator's "exhausted by question batches" pattern
- AISDLC-461 — distributed scheduler RFC (parent vision; this is the "observability + decision routing" pillar)
- AISDLC-462 — tmux wrapper (the 5x interrupt multiplier this task solves before it ships)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `cli-decisions add` accepts `--priority`, `--timebox-hours`, `--autonomous-fallback`, `--impact-score`, `--context-ref` flags (backward-compat: defaults preserve existing behavior)
- [ ] #2 `cli-decisions list --ranked` exists and orders by `priority × impact × urgency-decay` formula (documented + tested)
- [ ] #3 `cli-decisions resolve <id> --option <id>` exists for operator-driven resolution; writes audit event
- [ ] #4 `cli-decisions auto-expire` subcommand exists: scans pending decisions, picks autonomous-fallback on timebox expiry, writes 'auto-expired' audit event
- [ ] #5 New skill `decision-queue` (or `cli-decisions ask` subcommand) wraps: file decision + optionally surface inline via AskUserQuestion when priority >= medium AND operator is in-session
- [ ] #6 All in-tree AskUserQuestion call sites in pipeline-cli + ai-sdlc-plugin migrated to the new decision-queue wrapper (or documented exception)
- [ ] #7 Decision Catalog audit trail captures: resolver (operator-id | 'auto-expired'), chosen option, rationale, surfacing context (agent + task/PR backlink)
- [ ] #8 TUI extension: new Decisions pane in cli-tui.mjs renders ranked queue + resolve action
- [ ] #9 Documentation: spec/rfcs/RFC-0035 amended with the queue/timebox/auto-expire extension; operator runbook in docs/operations/decision-queue.md
- [ ] #10 Hermetic tests cover: priority ranking, timebox expiry + fallback selection, audit-trail completeness, in-session vs deferred surfacing logic
<!-- AC:END -->
