---
id: AISDLC-20
title: Tokens Studio DesignTokenProvider Adapter Implementation
status: Done
assignee: []
created_date: '2026-04-13 22:55'
updated_date: '2026-04-13 23:46'
labels:
  - adapter
  - implementation
  - tokens-studio
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
Implement the DesignTokenProvider interface against Tokens Studio's Git-based token storage.

Tokens Studio stores W3C DTCG tokens in a Git repository as JSON files. The adapter:
- Reads token JSON files, parses W3C DTCG format ($type, $value, $description)
- Diffs token snapshots (add/modify/remove)
- Detects deletions (tokens present in baseline but absent in current)
- Detects breaking changes (removals, renames, type changes, alias restructurings — value changes are non-breaking)
- Pushes token updates via Git commits
- Subscription methods (onTokensChanged, onTokensDeleted) use filesystem watching or Git polling
- getSchemaVersion reads from version file or package.json

Includes a dtcg-parser.ts module for W3C DTCG format parsing. Adapter metadata YAML for registry discovery. Registered as DesignTokenProvider@v1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Full DesignTokenProvider implementation — all 8 methods functional
- [x] #2 Parses W3C DTCG format tokens correctly
- [x] #3 diffTokens returns accurate add/modify/remove diffs
- [x] #4 detectDeletions identifies removed tokens
- [x] #5 detectBreakingChange classifies removals/renames/type-changes as breaking; value changes as non-breaking
- [x] #6 pushTokens creates Git commit with updated token files
- [x] #7 Integration test against fixture token repository
- [x] #8 Adapter metadata YAML and registry registration
<!-- AC:END -->
