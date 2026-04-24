---
id: AISDLC-32
title: Coverage hook detects turbo/nx and uses -- passthrough or dedicated script
status: Done
assignee: []
created_date: '2026-04-22 03:19'
updated_date: '2026-04-23 21:24'
labels:
  - plugin
  - hooks
  - turbo
  - dx
dependencies: []
references:
  - ai-sdlc-plugin/hooks/deferred-coverage-check.js
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When test is backed by turbo (turbo test), passing --coverage directly fails because turbo consumes it as its own flag. The fallback branch (pnpm test -- --coverage) has the -- separator and would work, but the primary branch that triggers for pnpm repos lacks it.

Fix: detect turbo.json or nx.json in the project root. If present, either use the dedicated test:coverage script (already fixed in PR #60) or always use the -- form. Consider emitting a template test:coverage script for the user if neither exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Detects turbo.json or nx.json in project root
- [x] #2 Uses dedicated test:coverage script when available
- [x] #3 Falls back to -- passthrough form for turbo/nx projects
- [x] #4 Optionally suggests a test:coverage script if none exists
<!-- AC:END -->
