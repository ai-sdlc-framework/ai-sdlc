---
id: AISDLC-275
title: 'feat: RFC-0024 Refit Phase 3 — Threshold-gated triage + severity (OQ-2 + OQ-5)'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-3
  - critical-path-rfc-0035
dependencies:
  - AISDLC-321
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 3. Wires the Phase 2 classifier substrate into the capture triage and severity-inference paths (OQ-2 + OQ-5).

## Scope (OQ-2 threshold-gated triage)

- AI-agent-filed captures get auto-triaged via classifier with confidence score.
- High-confidence (≥ threshold): triage auto-applied; auto-submitted to team-shared per OQ-1.
- Low-confidence (< threshold): `triage: pending`, draft state, surfaces in operator review queue.
- Per-agent threshold override allowed (e.g., security-reviewer stricter, code-reviewer looser).
- TUI "AI auto-triaged this; confirm?" badge for high-confidence cases (Phase 8 surfaces this).

## Scope (OQ-5 threshold-gated severity)

- Capture writer auto-infers severity via classifier with same shared threshold.
- High-confidence: severity auto-set with "AI suggested" badge.
- Low-confidence: severity stays `unknown` until operator sets at triage time.
- Per §15.1 lifecycle defaults: `severity: unknown` auto-classifies via classifier after 14d (per-org configurable; Phase 6 implements the timebox).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 AI-agent captures auto-triaged via Phase 2 classifier
- [ ] #2 High-confidence triage auto-applied; auto-submit per OQ-1
- [ ] #3 Low-confidence stays `triage: pending` in draft state
- [ ] #4 Per-agent threshold override read from agent role config
- [ ] #5 Severity auto-inferred when confidence ≥ threshold; `unknown` otherwise
- [ ] #6 Operator override of auto-triage / auto-severity emits negative exemplar
- [ ] #7 Integration test: confidence > threshold path + confidence < threshold path
<!-- AC:END -->
