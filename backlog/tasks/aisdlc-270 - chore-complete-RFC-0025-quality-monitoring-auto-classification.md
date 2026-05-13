---
id: AISDLC-270
title: 'chore: complete RFC-0025 quality monitoring auto-classification'
status: To Do
assignee: []
created_date: '2026-05-13 18:48'
labels:
  - rfc-0025
  - retrofit-followup
  - framework-quality
dependencies: []
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - pipeline-cli/src/tui/analytics/quality-reader.ts
  - pipeline-cli/src/orchestrator/playbook/handlers/
  - 'https://github.com/ai-sdlc-framework/ai-sdlc/pull/467'
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete the unbuilt portion of [RFC-0025 (Framework Quality Monitoring — Non-Decision Failure Modes)](../../spec/rfcs/RFC-0025-framework-quality-monitoring.md). The reliability-trend reader and failure-mode handlers ship today; the auto-classification, framework-bug routing, and severity rubric do not.

## What ships today (per 2026-05-13 audit)

- `pipeline-cli/src/tui/analytics/quality-reader.ts` — reads `_quality/captures.jsonl` and computes the §8 reliability trend. The file itself notes "RFC-0025 has not yet shipped Phase 5" and treats missing input as `available: false`
- `pipeline-cli/src/orchestrator/playbook/handlers/` — 9 catalogued failure-mode handlers (verification-failure, push-race, rebase-conflict, attestation-verify-mismatch, etc.) — implements the spirit of the §3 failure-mode taxonomy

## What's missing

- `cli-quality-corpus aggregate` CLI (referenced as "eventual" in the reader)
- Automatic classification of failures into `operator-under-decided` / `framework-misbehaved` / `ambiguous` / `external-dependency-failed` per §5
- Automatic routing of `framework-misbehaved` cases into the backlog with `triage: framework-bug` (§6)
- Severity-scoring rubric in code per §7 (operator-time-cost × blast-radius × frequency)
- MTTR / recurrence metric computation per §8
- `framework-determinism-violated` detection mechanism (RFC-0025 OQ-7)

## Why this matters

RFC-0025 operationalizes `VISION.md` §4 "honest failure modes" — when the framework misbehaves (vs. when the operator under-decided), the framework should route a bugfix into its own backlog rather than blaming the operator. Without auto-classification, the framework's failure modes get silently absorbed as operator-time-cost.

## Pre-work required

The 10 Open Questions in RFC-0025 §13 still need an operator walkthrough before this implementation can land. Each OQ has an author "Recommendation"; the walkthrough resolves them.

## References

- RFC-0025 body §3 (failure-mode taxonomy), §5 (classification), §6 (detection), §7 (severity rubric), §8 (self-improvement metrics)
- `pipeline-cli/src/tui/analytics/quality-reader.ts` (existing trend reader)
- `pipeline-cli/src/orchestrator/playbook/handlers/` (existing failure-mode handlers)
- PR #467 — Partial implementation status annotation that surfaced this gap
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `cli-quality-corpus aggregate` CLI ships and produces `_quality/captures.jsonl` from per-run logs
- [ ] #2 Classifier ships per §5 (operator-under-decided / framework-misbehaved / ambiguous / external-dependency-failed); default to `ambiguous` per OQ-1 recommendation
- [ ] #3 Auto-routing of `framework-misbehaved` cases into backlog with `triage: framework-bug` per §6 (composes with RFC-0024's capture flow)
- [ ] #4 Severity scoring rubric in code per §7 (operator-time-cost × blast-radius × frequency)
- [ ] #5 MTTR + recurrence-rate metrics computed per §8 and surfaced in TUI analytics
- [ ] #6 `framework-determinism-violated` detection per OQ-7 (sampled 1-in-50 baseline, always for `requires-determinism: true` tasks)
- [ ] #7 Vendor-namespace enforcement for adopter custom subclasses per §10 + OQ-10 (schema rejects un-namespaced)
- [ ] #8 RFC-0025 §13 OQs resolved with normative answers (operator walkthrough required first)
- [ ] #9 RFC-0025 lifecycle flipped to Implemented; registry row + inventory entry updated
<!-- AC:END -->
