---
id: AISDLC-27
title: Design CI Boundary — Deterministic Design Checks (Layer 1)
status: Done
assignee: []
created_date: '2026-04-13 22:56'
updated_date: '2026-04-14 00:04'
labels:
  - design-ci
  - deterministic
  - addendum-a
  - M7
milestone: m-0
dependencies:
  - AISDLC-16
  - AISDLC-15
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - reference/src/policy/enforcement.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement Layer 1 of the three-layer design review architecture from Addendum A §A.3.

Six deterministic design checks:
1. Accessibility audit (axe-core engine, WCAG 2.2 AA) — color contrast, ARIA roles, focus management, labels, alt text. Run against all stories at all viewports.
2. Touch target validation — 44px minimum for interactive elements (WCAG 2.5.8)
3. Typography scale compliance — font-size, line-height, letter-spacing values must come from token scale
4. Spacing grid compliance — margin, padding, gap values must be multiples of base unit (configurable, default 4px)
5. Color palette compliance — all color values from defined palette (primitive + semantic tokens)
6. Interactive state completeness — required states (default, hover, focus, active, disabled, loading) must have Storybook stories

Design CI Boundary declaration (§A.3.2): generated from check results, prepended to all downstream review contexts with reviewerAction: skip for each automated category. Tells human reviewers and AI agents exactly what is already covered.

Six new gate rule types added to GateRule union: accessibilityAudit, interactiveElementSize, typographyScaleCompliance, spacingGridCompliance, colorPaletteCompliance, interactiveStateCompleteness.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Six deterministic check implementations, each returning structured pass/fail
- [x] #2 Design CI Boundary declaration generated from check results
- [x] #3 accessibilityAudit rule type integrates with axe-core (injectable engine)
- [x] #4 interactiveElementSize validates 44px minimum
- [x] #5 Typography, spacing, color, state completeness checks validate against tokens
- [x] #6 Boundary declaration includes reviewerAction: skip for all automated categories
- [x] #7 Quality gate schema extended with six new rule types
- [x] #8 GateRule union and enforcement engine updated
- [x] #9 Unit tests for all six checks
<!-- AC:END -->
