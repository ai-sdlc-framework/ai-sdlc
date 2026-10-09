---
id: AISDLC-778
title: >-
  evaluation corpus and ranking gate for cli-context
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-2
dependencies:
  - AISDLC-775
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - orchestrator/src/embedding/index.ts
  - pipeline-cli/src/cli/index.ts
  - .github/workflows/ci.yml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the RFC-0053 evaluation corpus and ranking gate, as resolved by OQ-5. A hand-authored golden set of questions with relevance judgments is the regression gate. `cli-context eval` scores a run with recall at 5, MRR and nDCG. A transcript miner writes mined questions to an evaluator-only quarantine directory (never a prompt to an agent), scrubbed and de-duplicated, refreshed on a schedule. A synthetic generator produces questions from entries to fill coverage gaps. A CI job fails when golden recall at 5 is below `evaluation.goldenRecallAt5` (0.8) or regresses by more than `evaluation.maxRegressionPoints` (2) against the previous release. Both keys are configuration changed only through a decision record. A golden question whose entry no longer exists retires. A hook exposes the production citation rate from the load ledger as a report-only signal.

Sequencing: listed in `dependencies:` (AISDLC-775).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A golden set file with relevance judgments exists and `cli-context eval` computes recall at 5, MRR and nDCG on it (test against a fixture index with known scores).
- [ ] The CI job fails when recall at 5 is below 0.8 and passes at or above it (hermetic test).
- [ ] The CI job fails when recall at 5 drops more than 2 points from the stored previous-release value and passes within 2 points (test).
- [ ] `evaluation.goldenRecallAt5` and `evaluation.maxRegressionPoints` are read from `.ai-sdlc/context.yaml` with the stated defaults (test).
- [ ] The transcript miner writes only to the quarantine directory, scrubs secrets and identifiers, and de-duplicates repeated questions (test per behavior).
- [ ] Mined questions never enter a prompt: a test asserts the quarantine directory is not read by any hook or agent prompt builder.
- [ ] A synthetic question generator produces at least one question per entry in a fixture corpus (test).
- [ ] A golden question whose entry no longer exists is reported as retired and excluded from the score (test).
- [ ] A report hook prints the citation rate (injected entries later cited or acted on) without gating (test).
