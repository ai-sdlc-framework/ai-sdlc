---
id: AISDLC-431
title: 'feat: RFC-0030 OQ-13.2 re-walkthrough refinement — per-org acceptedLanguages config + franc language detection'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - rfc-0030
  - signal-ingestion
  - re-walkthrough-refinement
  - i18n
dependencies: []
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.2 (multi-language signal processing). Lands on top of shipped Phase 2 + Phase 3 substrate (AISDLC-344, AISDLC-345 in `backlog/completed/`).

## Scope (RFC-0030 §13.2 v0.3 refinements)

- **Add `franc` library** (deterministic; <10ms per signal; JS-native; MIT-licensed; 95%+ accuracy on text >50 chars) for language detection at the classifier stage.
- **Per-org `acceptedLanguages` config** in `.ai-sdlc/signal-ingestion.yaml`:
  - Default: `[en]` (English-only; matches conservative v0.2 intent)
  - Multi-language opt-in: `[en, fr, es, ...]` (orgs with non-English customer bases opt in knowingly, accepting documented BM25 quality degradation)
- **Non-accepted-language signals**: `Decision: signal-language-unsupported` → drop + log to catalog for visible-gap metric (no pipeline halt).
- **Operator runbook update**: document the multi-language trade-off — BM25 precision degrades ~15-30% without per-language stopwords/stemming (Robertson & Zaragoza §3.5); LLM ICP-resonance and embedding clustering are native multi-language; per-org opt-in is the right model for "you know your data better than the framework does."
- **Hermetic tests**: deterministic language detection (franc returns same answer for same input); acceptedLanguages config respected; Decision emitted on language drop; visible-gap metric increments.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `franc` library wired into classifier; per-signal detection runs in <10ms median
- [ ] #2 Per-org `acceptedLanguages: [en]` default in `.ai-sdlc/signal-ingestion.yaml`; multi-language opt-in via config
- [ ] #3 Non-accepted-language signals dropped with `Decision: signal-language-unsupported` to catalog
- [ ] #4 Visible-gap metric increments on language drop (operator runbook explains it)
- [ ] #5 Operator runbook section "Multi-language signals: when to opt in" published with BM25 quality-degradation caveat
- [ ] #6 Hermetic tests for franc determinism (same input → same output), config respect, Decision emission
<!-- AC:END -->
