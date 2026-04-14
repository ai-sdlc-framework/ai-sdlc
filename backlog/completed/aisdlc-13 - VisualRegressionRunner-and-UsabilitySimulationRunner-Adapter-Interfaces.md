---
id: AISDLC-13
title: VisualRegressionRunner and UsabilitySimulationRunner Adapter Interfaces
status: Done
assignee: []
created_date: '2026-04-13 22:53'
updated_date: '2026-04-13 23:18'
labels:
  - adapter
  - interface
  - M2
milestone: m-0
dependencies:
  - AISDLC-10
references:
  - reference/src/adapters/interfaces.ts
  - reference/src/adapters/index.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define the VisualRegressionRunner and UsabilitySimulationRunner adapter interfaces in reference/src/adapters/interfaces.ts.

VisualRegressionRunner (4 methods): captureBaselines(), compareSnapshots(), getFailurePayload(), approveChange()

UsabilitySimulationRunner (4 methods): deployStory(), generatePersonas(), runSimulation(), aggregateResults()

Critical types:
- VisualRegressionFailure with changedRegions array (x, y, width, height, expectedTokens, actualValues) per RFC §8.4
- BrowserSession with connector (getPageState, executeAction, captureScreenshot) per RFC §A.5.2
- Persona, TaskPrompt, SimulationResult, UsabilityFinding, AggregatedUsabilityReport, PageState, AgentAction, ActionResult

Add both to AdapterInterfaces map.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 VisualRegressionRunner has 4 methods per RFC §9.3
- [x] #2 UsabilitySimulationRunner has 4 methods per RFC §A.5.2
- [x] #3 VisualRegressionFailure includes changedRegions with full geometry + token references
- [x] #4 BrowserSession includes connector with getPageState, executeAction, captureScreenshot
- [x] #5 SimulationResult includes metrics, actionTrace, and findings arrays
- [x] #6 All types exported from barrel
<!-- AC:END -->
