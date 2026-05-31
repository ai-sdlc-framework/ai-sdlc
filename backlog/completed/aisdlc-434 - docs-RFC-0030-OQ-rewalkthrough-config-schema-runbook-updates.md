---
id: AISDLC-434
title: 'docs: RFC-0030 re-walkthrough — §11 config schema + operator runbook updates rolling up AISDLC-430..433 refinements'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - rfc-0030
  - signal-ingestion
  - re-walkthrough-refinement
  - docs
dependencies:
  - AISDLC-430
  - AISDLC-431
  - AISDLC-432
  - AISDLC-433
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Docs roll-up task for the RFC-0030 re-walkthrough (2026-05-26). Ensures the §11 config schema published in code-shipped form (`.ai-sdlc/signal-ingestion.yaml` template + `ai-sdlc init` scaffolding) reflects all 5 OQ refinements AND the operator runbook covers the operational stories end-to-end.

## Scope

### §11 config schema updates (composing AISDLC-430..433)

Update the `.ai-sdlc/signal-ingestion.yaml` schema + `ai-sdlc init` template to include:

- `adapters` list constrained to env-var-based v1 set (OQ-13.1; AISDLC-430)
- `languageDetection.{library, acceptedLanguages, onUnsupported}` block (OQ-13.2; AISDLC-431)
- `residencyEnforcement.{sourceFromCompliancePosture, enforcementPoints, multiPostureBehavior}` block (OQ-13.3; AISDLC-432)
- `manualEntry.{auditTrail, dailyCapPerOperator, evidenceUrlOptional, qualityMetric}` block (OQ-13.4; AISDLC-430)
- `flooding.{detection, quarantine, reputationWeighting}` block (OQ-13.5; AISDLC-433)

### Operator runbook (`docs/operations/signal-ingestion.md`) sections

- **Choosing v1 adapters**: which adapters ship in v1 (env-var-based) and how to configure each (Zendesk PAT, Slack/Discord bot tokens, in-app API key)
- **Credential failures**: distinguishing `adapter-credential-not-configured` vs `adapter-credential-rejected` Decisions and which operator action each requires
- **Multi-language signals: when to opt in**: BM25 quality-degradation caveat (~15-30% precision drop); when adopters with non-English customer bases should flip `acceptedLanguages`
- **Residency enforcement points**: per-stage enforcement (fetchSignals, clustering, storage, unified-report); audit export format; multi-posture UNION semantics
- **Manual signal entry**: rate limits, optional `evidenceUrl`, manual-share quality metric thresholds and what they tell you about pipeline health
- **Adversarial flooding defense**: z-score algorithm, cold-start behavior, quarantine semantics, operator unquarantine workflow, v2 reputation-weighting deferral rationale
- **Re-walkthrough provenance**: cross-link to RFC-0030 v0.3 revision history; explain why these are refinements over v0.2 (not new features)

### Promotion runbook updates

`docs/operations/signal-ingestion-promotion.md` — explicit promotion criteria reflecting the refinements:
- Default-on flip eligible after 1 full corpus window with the refinement substrate (env-var adapters + franc detection + residency enforcement + rate limits + z-score flooding) running without operator-flagged regressions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.ai-sdlc/signal-ingestion.yaml` schema updated with all 5 OQ-refinement blocks (languageDetection, residencyEnforcement, manualEntry hardening, flooding, adapter scope constraint)
- [ ] #2 `ai-sdlc init` template ships with the refined defaults
- [ ] #3 `docs/operations/signal-ingestion.md` has all 6 runbook sections published
- [ ] #4 Each runbook section cross-links to its corresponding §13.X resolution in RFC-0030
- [ ] #5 `docs/operations/signal-ingestion-promotion.md` updated with refinement-aware promotion criteria
- [ ] #6 Tests verify the `ai-sdlc init` template parses cleanly + all default values match the spec
<!-- AC:END -->
