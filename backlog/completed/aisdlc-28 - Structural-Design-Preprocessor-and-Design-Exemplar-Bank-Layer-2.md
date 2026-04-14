---
id: AISDLC-28
title: Structural Design Preprocessor and Design Exemplar Bank (Layer 2)
status: Done
assignee: []
created_date: '2026-04-13 22:56'
updated_date: '2026-04-14 00:04'
labels:
  - preprocessor
  - exemplar-bank
  - addendum-a
  - M7
milestone: m-0
dependencies:
  - AISDLC-27
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - orchestrator/src/analysis/diff-analyzer.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement Layer 2 of the design review architecture from Addendum A §A.4 and the exemplar bank from §A.6.

Structural Design Preprocessor:
- Computes full StructuralDesignAnalysis interface: complexityScore (1-10), complexityFactors (variantCount, propCount, responsiveBreakpoints, interactiveStates, composedComponents, tokenReferences), spacingAnalysis (onGrid/offGrid counts, consistencyScore, offGridLocations), typographyAudit (unique sizes/heights/spacings, deviations from scale), colorAudit (unique/tokenized/hardcoded counts, paletteCompliance), stateCoverage (required/covered/missing states), reuseAnalysis (existing components used, new elements introduced, reuseScore)
- Components scoring 7+ auto-trigger design review regardless of other trigger conditions
- Findings prepended to review context as "Pre-Verified Structural Analysis"

Design Exemplar Bank:
- Loads .ai-sdlc/design-review-exemplars.yaml
- 7 design review principles codified (evidence-first, deterministic-first, context-awareness, severity-honesty, signal-over-noise, persona-grounding, scope-discipline)
- Labeled examples: true-positive, false-positive, borderline with diff snippets, verdicts, principle references
- Exemplar lookup by category and type for calibrating AI and human reviewers
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 analyzeStructure returns full StructuralDesignAnalysis
- [x] #2 Complexity score (1-10) computed from all six factors
- [x] #3 Spacing, typography, color, state coverage audits fully implemented
- [x] #4 Components scoring 7+ flagged as high-complexity
- [x] #5 Exemplar bank loads YAML, supports lookup by category and type
- [x] #6 7 design review principles codified as evaluation criteria
- [x] #7 Exemplar format matches RFC Addendum A §A.6.2
- [x] #8 Unit tests for complexity scoring, structural analysis, and exemplar loading
<!-- AC:END -->
