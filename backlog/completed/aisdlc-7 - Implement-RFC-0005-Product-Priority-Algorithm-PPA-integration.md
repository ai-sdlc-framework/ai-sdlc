---
id: AISDLC-7
title: Implement RFC-0005 Product Priority Algorithm (PPA) integration
status: Done
assignee: []
created_date: '2026-03-24 23:02'
updated_date: '2026-03-24 23:57'
labels:
  - product
  - rfc
  - ppa
  - infrastructure
dependencies: []
references:
  - spec/rfcs/RFC-0005-product-priority-algorithm.md
  - orchestrator/src/priority.ts
  - orchestrator/src/priority.test.ts
  - reference/src/reconciler/loop.ts
  - reference/src/adapters/interfaces.ts
  - orchestrator/src/watch.ts
  - orchestrator/src/execute.ts
documentation:
  - spec/rfcs/RFC-0004-cost-governance-and-attribution.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the remaining work from RFC-0005 to fully integrate the Product Priority Algorithm into the AI-SDLC framework. The PoC scoring engine, priority queue, and adapter interfaces are already merged. This task covers the schema, wiring, feedback loop, and contrib adapters needed to make PPA production-ready.

## Context
- RFC: spec/rfcs/RFC-0005-product-priority-algorithm.md
- PoC scoring: orchestrator/src/priority.ts (41 tests)
- Priority queue: reference/src/reconciler/loop.ts (5 new tests)
- Adapter interfaces: reference/src/adapters/interfaces.ts (SupportChannel, CrmProvider, AnalyticsProvider)
- Original proposal: PPA-v1.0-Product-Priority-Algorithm.md by Alexander Kline

## Work Items

### 1. Pipeline JSON Schema update
Add optional `priorityPolicy` field to `pipeline.schema.json` with sub-fields: enabled, minimumScore, minimumConfidence, soulPurpose, dimensions (marketForce bounds, humanCurve weights), calibration (enabled, lookbackPeriod), adapters (supportChannel, crm, analytics).

### 2. Wire computePriority() into startWatch()
In orchestrator/src/watch.ts, when `priorityPolicy.enabled` is true:
- Score all candidate issues via `computePriority()` before enqueue
- Pass `score.composite` as priority to `loop.enqueue(pipeline, priority)`
- Skip items below `minimumScore`
- Flag items below `minimumConfidence` for human review

### 3. Wire priority into executePipeline()
- Accept pre-computed priority score in `ExecuteOptions`
- Record priority metadata in provenance and cost receipt
- Pass priority score to episodic memory for calibration

### 4. Outcome feedback / calibration loop
- After pipeline completion, record priority-vs-outcome entry in StateStore
- Compute calibration coefficient Ck from historical entries within lookbackPeriod
- Feed Ck back into future `computePriority()` calls

### 5. Spec and documentation updates
- Update spec/spec.md with priority policy semantics
- Update glossary with PPA terms
- Update primer with prioritization architecture
- Update website docs (ai-sdlc-io)

### 6. Contrib adapter stubs
Create metadata.yaml and stub implementations for:
- Zendesk, Intercom (SupportChannel@v1)
- HubSpot, Salesforce (CrmProvider@v1)
- PostHog, Amplitude (AnalyticsProvider@v1)

### 7. Conformance tests
Add conformance test cases for priority scoring behavior (multiplicative zeroing, dimension bounds, override semantics).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Pipeline JSON Schema includes optional priorityPolicy field that validates with existing pipelines unchanged
- [ ] #2 startWatch() scores candidate issues via computePriority() and enqueues with priority ordering when priorityPolicy.enabled is true
- [ ] #3 executePipeline() records priority metadata in provenance and episodic memory
- [ ] #4 Calibration coefficient Ck is computed from historical priority-vs-outcome entries and fed back into scoring
- [ ] #5 spec.md, glossary, and primer updated with PPA semantics
- [ ] #6 Website documentation updated with PPA configuration guide
- [ ] #7 Contrib adapter stubs exist for at least 2 SupportChannel, 2 CrmProvider, and 2 AnalyticsProvider implementations
- [ ] #8 Conformance tests cover multiplicative zeroing, dimension bounds, override semantics, and calibration feedback
<!-- AC:END -->
