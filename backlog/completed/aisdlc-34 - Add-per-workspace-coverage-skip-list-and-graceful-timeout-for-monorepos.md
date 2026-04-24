---
id: AISDLC-34
title: Add per-workspace coverage skip-list and graceful timeout for monorepos
status: Done
assignee: []
created_date: '2026-04-22 03:19'
updated_date: '2026-04-23 21:24'
labels:
  - plugin
  - hooks
  - monorepo
  - performance
dependencies: []
references:
  - ai-sdlc-plugin/hooks/deferred-coverage-check.js
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Large frontend vitest suites under coverage are expensive (21MB+ output, didn't finish in time). In monorepos, the coverage hook becomes a friction tax on every Stop.

Fix: add configuration for:
1. aiSdlc.coverage.excludeWorkspaces — array of workspace names to skip coverage for (e.g., large frontend packages)
2. maxDurationMs — graceful timeout that exits 0 instead of blocking when coverage takes too long (default 120s is too aggressive for large suites)

Config could live in .ai-sdlc/coverage-config.yaml or as userConfig in plugin.json.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 excludeWorkspaces config skips named packages from coverage
- [x] #2 Graceful timeout exits 0 with advisory message instead of blocking
- [x] #3 Config is documented and discoverable
<!-- AC:END -->
