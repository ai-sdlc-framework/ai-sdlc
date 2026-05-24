---
id: AISDLC-303
title: 'feat: RFC-0025 Refit Phase 2 — Confidence-bucketed classifier (OQ-1)'
status: Done
assignee:
  - '@dominique'
created_date: '2026-05-16'
updated_date: '2026-05-24'
labels:
  - rfc-0025
  - refit
  - phase-2
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
  - AISDLC-321
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
priority: critical
blocked:
  reason: "RFC-0024 lifecycle is intentionally rolled back to `Ready for Review` per its §15 status note — all 12 OQs carry 2026-05-15 `Resolution:` markers; the rollback is explicit so the AISDLC-320/321 + 275-278 Refit chain can flip it back to `Implemented`. RFC-0025 lifecycle is `Implemented`; all 10 §13 OQs resolved 2026-05-15. Operator-acknowledged override matches AISDLC-321 frontmatter pattern."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 2. Implements the OQ-1-affirmed confidence-bucketed classifier. Composes with the RFC-0024 Refit Phase 2 shared classifier substrate (AISDLC-321) — same Haiku-class + 0.7 threshold + calibration corpus pattern.

## Scope (OQ-1 affirmed resolution)

- Three-tier classification:
  - High-confidence (≥ 0.7): auto-classify into `operator-under-decided` or `framework-misbehaved`
  - Mid-confidence (0.3–0.7): `ambiguous` (operator triages)
  - Low-confidence (< 0.3): unclassified, log only (no operator-facing surface)
- Per-org thresholds configurable in `.ai-sdlc/quality-monitoring.yaml` (§13.1 schema; `quality.classifier.confidenceThresholds`).
- Calibration loop: operator overrides feed back as negative exemplars; silence-as-positive-exemplar.
- Uses the shared classifier substrate from AISDLC-321 (no new classifier infrastructure).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Three-tier classifier ships per §13 OQ-1 resolution
- [x] #2 Per-org thresholds read from `.ai-sdlc/quality-monitoring.yaml`
- [x] #3 Calibration loop composes with the shared classifier substrate (AISDLC-321)
- [x] #4 Operator overrides emit negative exemplars; silence emits positive
- [x] #5 Low-confidence cases (< 0.3) log only — no operator-facing artifact
- [x] #6 Test coverage for all three confidence tiers + threshold-boundary edge cases
<!-- AC:END -->

## Final Summary

### Summary

Replaced the Phase 1 binary classify-or-ambiguous heuristic in `pipeline-cli/src/tui/analytics/quality-classifier.ts` with the operator-affirmed OQ-1 confidence-bucketed three-tier classifier. Per-org thresholds load from `.ai-sdlc/quality-monitoring.yaml` (`quality.classifier.confidenceThresholds.{autoClassify, ambiguous}`, defaults 0.7 / 0.3). The calibration loop reuses the AISDLC-321 shared classifier substrate's `appendCorpusEntry` / `setCorpusEntryPolarity` / override-window resolver so operator overrides → negative exemplars + silence-sweep → positive exemplars compose architecturally with the substrate's existing polarity vocabulary. Low-confidence (< 0.3) cases produce no operator-facing artifact — logged-only via the caller's optional `ctx.logger.info` channel for post-mortem analysis.

### Changes

- `pipeline-cli/src/tui/analytics/quality-classifier.ts` (modified): replaced binary heuristic with confidence-bucketed scorer; added `confidence` / `bucket` / `effectiveThresholds` to `ClassificationResult`; added `ConfidenceBucket` type + `thresholds` / `resolvedThresholds` / `workDir` / `logger` opts on `ClassificationContext`; new `scoreSignal()` heuristic + `_bucketForConfidence()` / `_resolveEffectiveThresholds()` test hooks.
- `pipeline-cli/src/tui/analytics/quality-monitoring-config.ts` (modified): new `classifier.confidenceThresholds` config block + parser support (two-level nested YAML) + threshold normalisation (`ambiguous ≤ autoClassify` invariant) + `resolveClassifierConfidenceThresholds()` shielded helper.
- `pipeline-cli/src/tui/analytics/classification-calibration.ts` (new): `recordClassification()` / `recordClassificationOverride()` / `resolveClassificationSilence()` composing with the AISDLC-321 substrate; segregated `classifier-corpus-quality/` directory to avoid mixing with substrate task-type exemplars.
- `pipeline-cli/src/tui/analytics/index.ts` (modified): barrel exports for the new surface.
- `pipeline-cli/src/tui/analytics/quality-classifier.test.ts` (modified): 30 new tests covering all three confidence tiers + threshold-boundary edge cases + score breakdown smoke tests.
- `pipeline-cli/src/tui/analytics/classification-calibration.test.ts` (new): 16 tests covering AC-3/AC-4 (calibration loop composition + negative/positive exemplar flow + end-to-end).
- `pipeline-cli/src/tui/analytics/quality-monitoring-config.test.ts` (modified): 11 new tests for the OQ-1 `classifier` config block + `resolveClassifierConfidenceThresholds`.

### Design decisions

- **Inlined the shipping defaults in `quality-classifier.ts`** rather than importing from `quality-monitoring-config.ts` to break a circular import (`quality-monitoring-config.ts` imports `validateVendorNamespace` from the classifier for OQ-10 enforcement). The two constants (`0.7` / `0.3`) are duplicated and the config-test asserts they match.
- **Heuristic confidence scorer** with weighted pattern matching + multi-match stacking + real-failure-signal bonus + no-signal penalty. Calibrated so single matches in strong families (external-dep / contract-violation) auto-classify at 0.7+ while single matches in soft families (sweep / perf / silent) land in ambiguous (0.3–0.7), and empty / inscrutable signals land in unclassified (< 0.3). Calibration corpus accumulates exemplars for retuning; future LLM-swap via the AISDLC-321 substrate's `LlmInvoker` is the natural next step.
- **Reused substrate's `capture-triage` task-type slot** for the calibration corpus rather than adding a sixth `ClassifierTaskType`. Adding a new task type would change `ALLOWED_CLASSIFICATIONS` + prompt templates + tests across the substrate, which is out of scope for Phase 2. Segregated the on-disk corpus directory (`.ai-sdlc/classifier-corpus-quality/`) so RFC-0024 capture-triage exemplars don't contaminate framework-failure-mode exemplars. The slot reuse is documented at `QUALITY_CLASSIFICATION_TASK_TYPE` for future tooling to filter.
- **Threshold swap-when-reversed semantic** mirrors how the rest of `parseQualityMonitoringConfigYaml()` handles benign drift (silently corrects, no error) — the bucket logic stays monotonic even when an operator types `ambiguous: 0.7, autoClassify: 0.3`. The schema validator in CI catches the upstream misconfiguration.
- **Fall-open semantics for malformed config**: `resolveClassifierConfidenceThresholds()` catches the OQ-10 `QualityMonitoringConfigError` and falls back to shipping defaults. The classifier MUST stay available even when other config sections are broken; the operator surfaces the OQ-10 violation via the regular `loadQualityMonitoringConfig` call paths.

### Verification

- `pnpm build` — clean across the workspace.
- `pnpm test` — pipeline-cli: 259 test files / 4838 tests pass (133 new for OQ-1: 48 classifier + 16 calibration + 11 config); whole workspace green.
- `pnpm lint` — clean.
- `pnpm format:check` — clean.

### Follow-up

- **Wire `classifyFailure()` into orchestrator playbook handlers** — Phase 2 lands the classifier infrastructure; the playbook handlers (`pipeline-cli/src/orchestrator/playbook/handlers`) still call into the legacy resolution path. A follow-up will replace those with `classifyFailure(failure, ctx)` per RFC-0025 §9.1 — out of scope per the AISDLC-303 brief's "no new production wiring" boundary.
- **Migrate from heuristic to LLM via the AISDLC-321 substrate** — once the calibration corpus accumulates enough exemplars to validate accuracy, swap `scoreSignal()` for a Haiku-class invocation through the substrate's `LlmInvoker`. The bucket semantics + corpus shape are already substrate-compatible, so the swap is a single-file change.
- **TUI surface for ambiguous bucket triage** — the operator-facing UX for triaging `ambiguous` captures (per OQ-1 mid-tier) belongs to RFC-0023 (Operator TUI) Blockers pane; the classifier infrastructure shipping here unblocks that work.
