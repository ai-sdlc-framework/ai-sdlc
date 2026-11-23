---
id: AISDLC-1403
title: 'Journey accessibility audits fall due per cadence from operator-recorded audits'
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - rfc-0018
  - journey
  - orchestrator
  - compliance
dependencies:
  - AISDLC-1400
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/schemas/journey.v1.schema.json
  - spec/schemas/compliance-posture.v1.schema.json
  - spec/schemas/metric-snapshot.v1.schema.json
  - spec/schemas/journey-config.v1.schema.json
  - orchestrator/src/journey/metric-snapshot.ts
  - orchestrator/src/journey/inheritance-validator.ts
  - orchestrator/src/compliance/types.ts
assumes:
  - RFC-0018
priority: medium
---

## Description

**Gap.** RFC-0018's OQ-6 amendments say when a journey's accessibility audit falls due. v0.4 (PR #2967) added due dates per `auditCadence`, partial and full audits, and the earliest due date across journey and posture cadences. v0.4.1 (PR #2970, the Engineering amendment) defined the records those rules read from. Today `computeAuditOverdueErho5` (`orchestrator/src/journey/metric-snapshot.ts`) applies the graduated degradation, but no audit record, release definition or declaration date exists to compute a due date from. RFC-0022 `auditFrequency` (`compliance-posture.v1.schema.json`: `annual | continuous | on-demand`) is set per regime, covers every regime and doesn't match the journey enum.

**Source.** RFC-0018 §9: v0.4 follow-up "Audit due dates per cadence..." and the v0.4.1 follow-up naming AISDLC-1403. Rulings: OQ-6 "Engineering amendment (v0.4.1)" items 1-4.

**Out of scope.** The WCAG criteria table, the `additionalCriteria` checks and the emission of `wcag-version-not-latest` (AISDLC-1402, which reuses this task's PR base-and-head comparator).

## Fix

- **`AccessibilityAudit` resource** (new `spec/schemas/accessibility-audit.v1.schema.json`), loaded the same way as `MetricSnapshot`. Fields: `metadata.journey` (path-style journey URI), `spec.auditedAt` (date), `spec.scope` (`full` or `partial`), `spec.statesCovered[]` (required when `partial`, each a state id of the journey), and required `spec.auditor` and `spec.reportUrl`. The framework reads the date, scope and states but doesn't verify the audit.
- **`declaredAt`** on journeys (§5.2, §6.1; required, `format: date`). The declaration validator rejects a future date. Add a declaration comparator that reads a journey's declaration at the PR base and the PR head; it rejects any change to `declaredAt` on a journey that exists in both. Make the comparator a reusable function, because AISDLC-1402 uses it for the advisory. Loader migration message for v0.3 declarations without `declaredAt` (§6.3).
- **Release detection** for `release-gated`: a release is a git tag matching `accessibility.releaseTagPattern` in `journey-config` (default `v*`). The work it ships is the merges between the previous matching tag and this one whose work item lists the journey in `targetedJourneys`. For `continuous`, each such merged PR is a due date.
- **Due dates** per the OQ-6 cadence table: `annually` 12 months and `quarterly` 3 months after the last audit, `release-gated` on each release date, `continuous` on each merge date. `declaredAt` counts as the first audit. For `release-gated` and `continuous`, a full audit also falls due 12 months after the last full one. A partial audit clears earlier due dates only for the states it covers; a full audit clears all of them.
- **Postures:** only regimes whose `id` is in `accessibility.accessibilityRegimes` feed the earliest-due-date rule. The default list is `Section-508`, `EN-301-549`, `EAA`, `ADA-Title-II`, `ADA-Title-III` and `AODA`; an org extends it in `journey-config`. Map `auditFrequency`: `annual` → `annually`, `continuous` → `continuous`, `on-demand` → no due date.
- Feed days overdue (from the earliest unmet due date) into the existing graduated Eρ₅ degradation and its three Decisions. An automated scan never creates an `AccessibilityAudit`.
- `journey-config.v1.schema.json`: add `auditRecord`, `releaseTagPattern` and `accessibilityRegimes` per §10.1.

## Acceptance Criteria

- [ ] #1 Schema tests: `AccessibilityAudit` without `auditor` or `reportUrl` fails; `scope: partial` without `statesCovered` fails; a `statesCovered` id that isn't a state of the journey fails.
- [ ] #2 Tests: a journey without `declaredAt` fails to load with the migration message; a future `declaredAt` fails; the comparator fails a PR that changes `declaredAt` on an existing journey and passes one that adds a new journey.
- [ ] #3 Tests for each cadence: the due date is computed from the last audit, and days overdue feed the existing warn / -25% / -50% / block thresholds.
- [ ] #4 Tests: a partial audit clears due dates only for the states it covers, and a full audit clears all. For `release-gated` and `continuous`, a full audit falls due 12 months after the last full one even with partial audits in between.
- [ ] #5 Test: a newly declared journey with no audit is not overdue on its `declaredAt` date.
- [ ] #6 Tests: under the default `v*` pattern, a `v1.2.0` tag is a release for a `release-gated` journey and a `nightly-1` tag isn't. A release whose merges don't target the journey sets no due date.
- [ ] #7 Tests: an `EN-301-549` posture with `auditFrequency: continuous` tightens an `annually` journey. A `SOC2` posture with `continuous` doesn't. An org-added regime id in `accessibilityRegimes` does.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
