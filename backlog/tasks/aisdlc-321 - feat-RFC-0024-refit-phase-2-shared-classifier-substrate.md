---
id: AISDLC-321
title: 'feat: RFC-0024 Refit Phase 2 — Shared classifier substrate (Haiku + 0.7 threshold + calibration corpus)'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-2
  - critical-path-rfc-0035
  - classifier-keystone
dependencies:
  - AISDLC-320
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 2 — the keystone task. Ships the shared classifier substrate that OQ-2 (auto-triage), OQ-3 (PR-comment auto-classify), OQ-5 (severity inference), OQ-11 (DoR-clarification classifier), and RFC-0035 Phase 5 (Stage C LLM classifier) all compose on.

## Why a shared substrate

The 2026-05-15 OQ revisions converged on a single architectural pattern: Haiku-class LLM classifier + 0.7 confidence threshold + shared calibration corpus + auto-apply-with-override-window. Implementing this once at the framework level prevents 4-5 duplicate classifier pipelines and gives the calibration loop a single corpus to learn from.

## Scope

- `pipeline-cli/src/classifier/` package with public API: `classify(input, taskType, opts) → { classification, confidence, reasoning }`
- Haiku-class model invocation (configurable per-org: which model, which provider)
- 0.7 confidence threshold default; per-call override allowed; per-org default configurable via `capture-config.yaml` and `decisions-config.yaml`
- Calibration corpus aggregator: `cli-classifier corpus aggregate` emits the aggregated training corpus.
- Operator-override capture: when operator overrides an auto-classification within the override window, that becomes a negative exemplar in the corpus.
- Silence-as-positive-exemplar: no override within window → positive exemplar promoted to corpus.
- Multi-task-type support: same substrate serves capture-triage / capture-severity / pr-comment-is-capture / dor-answer-is-new-concern / decision-recommendation (RFC-0035) — each with its own task-type prompt template.
- Subscription cost tracking via SubscriptionLedger (RFC-0010).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `pipeline-cli/src/classifier/` package ships with `classify()` public API
- [ ] #2 Haiku-class model invocation (configurable per-org)
- [ ] #3 0.7 confidence threshold default; per-call override + per-org config respected
- [ ] #4 Calibration corpus written to `.ai-sdlc/classifier-corpus/<task-type>.yaml` (per-task-type)
- [ ] #5 `cli-classifier corpus aggregate` emits the aggregated training corpus
- [ ] #6 Operator-override capture writes negative exemplar to corpus
- [ ] #7 Silence-as-positive-exemplar: no override within window → positive exemplar
- [ ] #8 Multi-task-type support documented (capture-triage / capture-severity / pr-comment-is-capture / dor-answer-is-new-concern / decision-recommendation)
- [ ] #9 Subscription cost tracked via SubscriptionLedger; default cap per-org configurable
- [ ] #10 Public API documented for downstream consumers (OQ-2/3/5/11 + RFC-0035 P5)
<!-- AC:END -->
