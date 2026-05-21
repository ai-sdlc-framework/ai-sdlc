---
id: AISDLC-384
title: 'chore(governance): audit friction of remaining ~14 non-attestation gates after RFC-0042 lands'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - governance
  - friction-reduction
  - audit
dependencies:
  - AISDLC-383
priority: high
blocked:
  reason: 'Awaits AISDLC-383 (RFC-0042) shipping. Audit only makes sense once attestation friction is removed and the non-attestation gates become the dominant remaining pain.'
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
---

## Problem

RFC-0042 (AISDLC-383) eliminates ~13 attestation-pipeline gates which are the dominant source of shipping friction. After it ships, ~14 non-attestation gates remain. Operator signal 2026-05-20: "this friction is killing this project."

Without an explicit audit pass, the remaining gates will continue accumulating without budget enforcement. This task forces the conversation: which gates earn their friction, which don't.

## Scope — audit the following gates

### Pre-push hooks (Husky chain)

- `scripts/check-coverage.sh` — runs full test suite locally, ~1 min, forces re-push on coverage regression
- `scripts/check-task-moved.sh` — auto-moves task file, forces re-push every PR with `(AISDLC-N)` subject
- `scripts/check-dor-gate.sh` — DoR rubric validation, needs pipeline-cli built, no-op fallback messy
- `scripts/check-skip-ci-marker.sh` — defensive marker check (low friction, probably keep)
- `scripts/check-backlog-ascii.sh` — filename ASCII check (low friction, probably keep)
- `scripts/check-orchestrator-state.sh` — parent-on-main guard (auto-recovers when clean, low friction)

### DoR rubric gates (7 gates per task)

Per RFC-0011:
- Gate 1: title shape
- Gate 2: hidden markers (TBD/XXX/TODO)
- Gate 3: named-thing references resolve
- Gate 4: acceptance criteria present + verifiable
- Gate 5: out-of-scope declared
- Gate 6: source captured
- Gate 7: invisible-dependency phrases

Plus AISDLC-296 upstream-OQ gate (rejects tasks referencing draft RFCs).

### Required CI checks

- Backlog Drift
- Coverage
- Build & Test (Node 20)
- Build & Test (Node 22)
- Lint & Format
- Integration Tests
- Detect Changes
- CI OK (rollup)
- ai-sdlc/pr-ready (rollup)
- Post Review Results
- Verify dist/bin.js
- Evaluate backlog tasks changed by PR (DoR ingress)
- ai-sdlc/issue-link (after PR #583)

### Drift gate

`backlog-drift` pre-commit + CI checks for broken references in task frontmatter.

## Acceptance criteria

- [ ] #1 Each gate above audited with: (a) friction cost in median per-PR seconds, (b) incidents prevented in last 90 days, (c) bypass usage frequency, (d) consolidation/removal recommendation
- [ ] #2 Output: audit report at `docs/operations/gate-friction-audit-2026.md`
- [ ] #3 Each gate ends up in one of three buckets: KEEP (justified), CONSOLIDATE (merge with another), DELETE (no incidents prevented)
- [ ] #4 Backlog tasks filed for each CONSOLIDATE + DELETE recommendation
- [ ] #5 Gate Friction Budget RFC drafted: "Every new pre-push or required-CI gate must justify <30s added per PR + zero env-var prompts in the default path. Existing gates given 30-day grace to comply or sunset."
- [ ] #6 RFC sign-off + initial enforcement (reject the next PR that adds a gate violating the budget)

## Out of scope

- Re-litigating RFC-0042 (the attestation rewrite) — that's AISDLC-383
- Removing gates without data — data-driven audit only
- Adopter-facing gate documentation — separate concern after audit settles

## Methodology

### 48-hour bypass experiment (Phase 1)

Set every `AI_SDLC_SKIP_*` env var in the operator's shell for 48 hours. Ship 5-10 PRs with no gates. Observe what actually breaks. Each broken thing is evidence that the corresponding gate has real value. Each non-broken thing is a candidate for deletion.

### Friction telemetry (Phase 2)

Instrument the pre-push hooks + CI workflows to emit timing + bypass-event metrics to `_events.jsonl`. Aggregate over a 30-day window. Output: per-gate friction histogram.

### Incidents-prevented audit (Phase 3)

Search backlog/completed/ + git log for AISDLC-NNN tasks that exist BECAUSE a gate caught something. Per gate, count incidents in last 90 days. Zero = candidate for deletion.

### Synthesis (Phase 4)

Combine bypass experiment + friction telemetry + incidents-prevented into the audit report.

## Source

Operator session 2026-05-20: filed alongside RFC-0042 to ensure the remaining ~50% friction (non-attestation gates) doesn't get forgotten after the attestation rewrite. Filed BEFORE RFC-0042 lands so it can't slip through the cracks of "ship the big thing, then everyone moves on."
