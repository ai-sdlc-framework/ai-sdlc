---
id: AISDLC-23
title: Playwright VisualRegressionRunner Adapter Implementation
status: Done
assignee: []
created_date: '2026-04-13 22:55'
updated_date: '2026-04-13 23:46'
labels:
  - adapter
  - implementation
  - playwright
  - M5
milestone: m-0
dependencies:
  - AISDLC-13
references:
  - reference/src/adapters/interfaces.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the VisualRegressionRunner interface using Playwright's screenshot and comparison APIs.

The adapter:
- Captures screenshots of Storybook stories at specified viewports via page.screenshot()
- Compares against stored baselines using pixel diffing
- Produces structured VisualRegressionFailure payloads with changedRegions (x, y, width, height, expectedTokens, actualValues)
- Supports baseline approval by copying current screenshots to baseline storage

getFailurePayload is critical — maps Playwright diff output to structured changedRegions format with geometry, expected tokens, and actual values.

Baseline storage uses filesystem (configurable path). Includes diff-utils.ts for pixel comparison and region extraction logic.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Full VisualRegressionRunner implementation — all 4 methods functional
- [x] #2 captureBaselines launches Playwright browser, captures at specified viewports
- [x] #3 compareSnapshots computes pixel diff percentage
- [x] #4 getFailurePayload returns structured changedRegions with geometry data
- [x] #5 approveChange copies current screenshot to baseline storage
- [x] #6 Configurable diffThreshold for pass/fail
- [x] #7 Test with fixture screenshots (no real Storybook required for unit tests)
<!-- AC:END -->
