---
id: AISDLC-31
title: Session-start detects missing coverage provider and emits remediation
status: Done
assignee: []
created_date: '2026-04-22 03:19'
updated_date: '2026-04-23 21:24'
labels:
  - plugin
  - hooks
  - dx
  - bug
dependencies: []
references:
  - ai-sdlc-plugin/hooks/deferred-coverage-check.js
  - ai-sdlc-plugin/hooks/session-start.sh
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When @vitest/coverage-v8 isn't installed, the deferred-coverage-check hook fails with a cryptic "Failed to load url @vitest/coverage-v8" error that blocks Stop. First-time users don't know what to do.

Fix: have session-start.sh detect vitest + no coverage-v8 at session start and emit a one-line remediation message (`pnpm add -D -w @vitest/coverage-v8`). Don't block Stop on a missing dev tool until the user has had a chance to install it. The coverage hook should also check for the provider before attempting to run.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 session-start detects vitest without @vitest/coverage-v8 and emits remediation advice
- [x] #2 deferred-coverage-check exits 0 when provider is missing (not exit 2)
- [x] #3 One-line actionable message: pnpm add -D -w @vitest/coverage-v8
<!-- AC:END -->
