---
id: AISDLC-21
title: Figma Variables DesignTokenProvider Adapter Implementation
status: Done
assignee: []
created_date: '2026-04-13 22:55'
updated_date: '2026-04-13 23:46'
labels:
  - adapter
  - implementation
  - figma
  - M5
milestone: m-0
dependencies:
  - AISDLC-12
references:
  - reference/src/adapters/interfaces.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the DesignTokenProvider interface against the Figma Variables REST API.

Scoped exclusively to token extraction (RFC §9.5 boundary — no design file reading or Figma Make). Uses Figma Variables API (GET /v1/files/:key/variables) to read variable collections and translate to W3C DTCG format. pushTokens writes back via POST /v1/files/:key/variables. Subscription methods poll the API on configurable interval.

Key implementation details:
- Translates Figma Variables → W3C DTCG (modes → token groups, collections → categories)
- Injectable HTTP client for testing (same pattern as GitHub adapter with Octokit)
- Authentication via Figma API token stored as secret reference
- detectBreakingChange compares variable collection snapshots
- Co-first with Tokens Studio — validates DesignTokenProvider interface against two real implementations

Includes figma-to-dtcg.ts module for the Figma → DTCG translation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Full DesignTokenProvider implementation — all 8 methods functional
- [x] #2 Translates Figma Variables to W3C DTCG format correctly
- [x] #3 HTTP client injectable for testing
- [x] #4 pushTokens writes variable values back to Figma
- [x] #5 Integration test with recorded HTTP fixtures
- [x] #6 Scope boundary enforced: no endpoints outside /variables API
- [x] #7 Adapter metadata YAML
<!-- AC:END -->
