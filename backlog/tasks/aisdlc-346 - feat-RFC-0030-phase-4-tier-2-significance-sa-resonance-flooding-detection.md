---
id: AISDLC-346
title: 'feat: RFC-0030 Phase 4 — Tier 2 significance threshold + SA resonance filter + flooding detection (catalog-routed)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-4
dependencies:
  - AISDLC-345
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0030 §8 + §9 + OQ-13.5. Tier 2 significance threshold, SA resonance filter, adversarial flooding detection.

## Scope (RFC-0030 §8 + §9 + OQ-13.5)

- **Tier 2 significance threshold** per §8: cluster must meet `minSignalCount` + `minUniqueSources` + `minTier1SignalCount` + `minClusterAgeDays` before passing to D1.
- **SA resonance filter** per §9 + RFC-0029 Principle 4: high-SA = full weight; mid-SA = discounted; low-SA = excluded but logged for Product review (composes with catalog).
- **OQ-13.5 flooding detection:** suspicious volume spike + low source diversity → `Decision: signal-flooding-detected` → Stage A classifies severity (volume threshold + source-diversity threshold + per-source baseline drift) → auto-throttle low-confidence sources at per-org configurable threshold OR surface to operator batch review for high-severity cases. Pipeline never halts.
- **OQ-13.3 residency violation detection** (composes with RFC-0022): adapter detects signal subject to declared regime constraint not met → `Decision: signal-residency-violation` → refuse signal + log + emit `compliance.yaml regimeOverrides` clarification task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Tier 2 significance threshold gate per §8 (minSignalCount + minUniqueSources + minTier1SignalCount + minClusterAgeDays)
- [ ] #2 SA resonance filter per §9: full / discounted / excluded tiers
- [ ] #3 Low-SA-but-high-volume signals logged via Decision for Product batch review (not silently dropped)
- [ ] #4 OQ-13.5 flooding detection: volume + source-diversity + baseline-drift Stage A classification
- [ ] #5 Flooding response: auto-throttle low-confidence OR operator-batch-surface high-severity
- [ ] #6 OQ-13.3 residency violation: adapter-level detection → Decision + refuse + emit clarification task
- [ ] #7 Pipeline never halts on flooding / residency / SA-zero events (all catalog-absorbed)
<!-- AC:END -->
