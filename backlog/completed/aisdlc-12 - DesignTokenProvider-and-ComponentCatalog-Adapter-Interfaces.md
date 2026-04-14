---
id: AISDLC-12
title: DesignTokenProvider and ComponentCatalog Adapter Interfaces
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
Define the DesignTokenProvider and ComponentCatalog adapter interfaces in reference/src/adapters/interfaces.ts, following the existing adapter pattern.

DesignTokenProvider (8 methods): getTokens(), diffTokens(), detectDeletions(), pushTokens(), onTokensChanged(), onTokensDeleted(), detectBreakingChange(), getSchemaVersion()

ComponentCatalog (5 methods): getManifest(), resolveComponent(), canCompose(), getStories(), validateAgainstCatalog()

Supporting types: DesignTokenSet, TokenDiff, TokenDeletion, PushResult, ComponentManifest, ComponentMatch, ComponentRequirement, CompositionPlan, Story (design-specific), Unsubscribe

Method signatures from RFC-0006 Sections 9.1 and 9.2. Add both interfaces to the AdapterInterfaces map. Export all new types from reference/src/adapters/index.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 DesignTokenProvider interface has all 8 methods per RFC §9.1
- [x] #2 ComponentCatalog interface has all 5 methods per RFC §9.2
- [x] #3 All supporting types defined with full field signatures
- [x] #4 AdapterInterfaces map includes both new entries
- [x] #5 All types exported from barrel index
<!-- AC:END -->
