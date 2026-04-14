---
id: AISDLC-29
title: Usability Simulation Runner Implementation and Task Library (Layer 3)
status: Done
assignee: []
created_date: '2026-04-13 22:57'
updated_date: '2026-04-14 00:04'
labels:
  - adapter
  - usability-simulation
  - addendum-a
  - M7
milestone: m-0
dependencies:
  - AISDLC-13
  - AISDLC-23
references:
  - reference/src/adapters/interfaces.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the full UsabilitySimulationRunner as a project-owned reference implementation per Addendum A §A.5.

Uses Playwright to deploy Storybook stories to headless browser environments. LLM agent interacts with live DOM via BrowserSession.connector interface (getPageState, executeAction, captureScreenshot).

Key components:
- deployStory: launches Playwright browser, navigates to story URL, returns BrowserSession
- generatePersonas: creates persona profiles from demographic config (techConfidence, ageRange, accessibilityNeeds)
- runSimulation: LLM agent executes task against live DOM, records full action trace (actions, hesitations, errors, backtracking)
- aggregateResults: combines results across personas with statistical analysis

Task auto-selection algorithm (§A.5.3.1):
1. Match component type from Storybook metadata to applicableTo arrays
2. Run ALL matching tasks (multiple patterns provide complementary coverage)
3. If exceeds maxTasksPerComponent (default 5), prioritize by failure history
4. If NO match: generate generic task prompt with 0.6 confidence ceiling
5. Log TaskLibraryGap events for feedback flywheel

Confidence filtering: suppress below 0.5. Meta-review for 0.5-0.8 findings via lightweight LLM call (UsabilityMetaReview with keep/suppress/adjust).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Full UsabilitySimulationRunner implementation — all 4 methods functional
- [x] #2 deployStory launches Playwright browser and returns BrowserSession with working connector
- [x] #3 generatePersonas creates profiles from demographic config
- [x] #4 runSimulation executes LLM agent against live DOM with full action trace
- [x] #5 aggregateResults combines across personas with statistical analysis
- [x] #6 Task auto-selection implements all 5 steps from §A.5.3.1
- [x] #7 Confidence filtering: below 0.5 suppressed
- [x] #8 Meta-review for medium-confidence findings (0.5-0.8)
- [x] #9 Task library YAML loading from .ai-sdlc/usability-tasks.yaml
- [x] #10 Integration tests with fixture stories
<!-- AC:END -->
