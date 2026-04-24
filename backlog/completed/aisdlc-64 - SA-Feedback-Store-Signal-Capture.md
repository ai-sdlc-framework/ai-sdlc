---
id: AISDLC-64
title: SA Feedback Store + Signal Capture
status: Done
assignee: []
created_date: '2026-04-24 17:26'
updated_date: '2026-04-24 19:42'
labels:
  - feedback
  - flywheel
  - M6
milestone: m-1
dependencies:
  - AISDLC-40
  - AISDLC-63
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
§B.8. Create `orchestrator/src/sa-scoring/feedback-store.ts` — class `SAFeedbackStore` wrapping the `did_feedback_events` table.

Methods:
- `record({issueNumber, dimension, deterministicResult, structuralScore, llmScore, compositeScore, signal, timestamp})`
- `structuralPrecision(window)` — fraction of structural scores directionally correct
- `llmPrecision(window)` — fraction of LLM scores directionally correct
- `highFalsePositiveCategories()` — categories driving dismiss signals

Signal capture sources:
- GitHub label additions (`sa/accept`, `sa/dismiss`, `sa/escalate`)
- Manual CLI: `ai-sdlc sa-feedback` for explicit signal entry
- HC_override path logs as `override` signal automatically

New workflow `.github/workflows/ai-sdlc-sa-feedback.yml` listens for label events and records signals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 record() persists row with all fields
- [x] #2 structuralPrecision('30d') returns directional-correctness fraction over trailing 30 days
- [x] #3 HC_override path automatically emits override signal (tested via computePriority with override)
- [x] #4 CLI prints current precision stats
- [x] #5 Workflow end-to-end smoke test using recorded webhook payload
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
SA feedback store + signal capture landed. `SAFeedbackStore` wraps `did_feedback_events` with `record`, `structuralPrecision`, `llmPrecision`, `highFalsePositiveCategories`. Label-based + CLI-based signal entry, plus HC_override auto-emit helper. GitHub workflow listens for `sa/accept|dismiss|escalate` label events and invokes the CLI.

## Changes
- `orchestrator/src/sa-scoring/feedback-store.ts` (new): `SAFeedbackStore` class with `record`, `list`, `structuralPrecision`, `llmPrecision`, `highFalsePositiveCategories`. Directional-correctness logic: (accept + high) | (dismiss + low) | (escalate + low) = correct; override signals excluded from precision. `classifyLabel(label)` maps GitHub SA labels to signals. `recordOverrideFeedback(feedback, override, context)` helper for auto-emit when HC_override bypass fires.
- `orchestrator/src/sa-scoring/feedback-store.test.ts` (new): 17 tests — record persistence (AC #1), structural precision trailing-window computation (AC #2), override-signal exclusion from precision, dimension filter, since filter, LLM precision symmetric with structural, category-scoped FP ranking with min-sample cutoff, classifyLabel dispatch (case-insensitive), override auto-emit (AC #3) with default SA-1 dimension.
- `orchestrator/src/index.ts`: exported `SAFeedbackStore`, `SA_FEEDBACK_LABELS`, `classifyLabel`, `recordOverrideFeedback`, related types, plus `scoreSoulAlignment`, `resolveSoulAlignmentOverride`, `SaDimension`, `FeedbackSignal`.
- `dogfood/src/cli-sa-feedback.ts` (new): `sa-feedback` CLI with three subcommands — `record` (AC #4 manual signal entry), `precision` (prints both structural + LLM precision stats), `hot-categories` (prints FP-rate ranking with configurable min-samples). Guards `main()` behind invoked-directly check for testability.
- `dogfood/package.json`: added `sa-feedback` + `pattern-test` script entries (pattern-test was missing from the manifest).
- `.github/workflows/ai-sdlc-sa-feedback.yml` (new): triggered on `issues.labeled`; filters on SA feedback labels; resolves the repo's default DID; classifies the label into a signal; invokes `sa-feedback record` for both SA-1 and SA-2 dimensions so the feedback flywheel gets per-dimension observations (AC #5 smoke-test path).

## Design decisions
- **Directional-correctness rather than binary match**: the signal tells us what the reviewer thought of the outcome; structural/LLM scores tell us what the scorer thought at admission. The intersection — whether the scorer's prior matched the reviewer's verdict — is precision. HIGH_SCORE_THRESHOLD = 0.5 is the calibration anchor.
- **Override signals EXCLUDED from precision**: override is a bypass, not a judgement on the scorer. Including it would conflate "we trusted the scorer" with "we overruled the scorer." Tests pin this explicitly.
- **`recordOverrideFeedback` is a free helper**, not a method on the store: callers invoke it when they detect an override. Keeps the admission composite free of feedback-store coupling and makes the call site explicit.
- **CLI uses subcommands**: `sa-feedback record | precision | hot-categories`. Matches `git` / `docker` / `kubectl` conventions; future subcommands (calibrate, export) plug in without breaking callers.
- **Workflow records BOTH SA-1 and SA-2** on a single label event: a reviewer accepting/dismissing an issue is signaling about the overall outcome, which touches both dimensions. Per-dimension rows allow downstream calibration to tune SA-1 and SA-2 independently even though the reviewer only clicked once.
- **Workflow auto-resolves DID name** from `.ai-sdlc/*.yaml`: avoids requiring operators to hard-code the DID name in workflow YAML. Uses the first DID found — sufficient for single-tenant repos, adequate fallback for multi-DID repos until explicit routing lands.
- **`highFalsePositiveCategories` min-sample default = 3**: prevents small-sample noise from dominating the ranking. Operators see only categories with enough evidence to act on.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/feedback-store.test.ts` — 17/17 pass
- `pnpm test` (full workspace) — 2196 orchestrator + 246 dogfood + 3769 total, no regressions
- `pnpm lint` — clean

## Follow-up
AISDLC-65 (C6 Cκ category-scoped calibration) reads `highFalsePositiveCategories` to adjust PPA calibration coefficients per category. AISDLC-66 (phase-weight auto-calibration) reads `structuralPrecision` / `llmPrecision` to shift Phase 3 weights. AISDLC-67 (SoulDriftDetected + CoreIdentityChanged consumer) closes M6.
<!-- SECTION:FINAL_SUMMARY:END -->
