---
id: AISDLC-35
title: Coverage hook emits one-line actionable error instead of raw tool output
status: Done
assignee: []
created_date: '2026-04-22 03:19'
updated_date: '2026-04-23 21:24'
labels:
  - plugin
  - hooks
  - dx
dependencies: []
references:
  - ai-sdlc-plugin/hooks/deferred-coverage-check.js
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When the coverage hook fails, it dumps raw turbo/vitest output (500 chars of stderr). This is noisy and unhelpful — users need to debug what the hook is complaining about.

Fix: parse the error into a one-line summary with actionable remediation. Examples:
- "Coverage failed on @fizbans-forge/sdk — missing @vitest/coverage-v8? Try: pnpm add -D -w @vitest/coverage-v8"
- "Coverage is 72% on @ai-sdlc/orchestrator (threshold: 80%). Add tests for: src/config.ts, src/execute.ts"
- "Tests failed in @ai-sdlc/reference — 3 test(s) failing. Run: pnpm --filter @ai-sdlc/reference test"
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Error messages are one-line summaries with actionable next step
- [x] #2 Raw stderr is not dumped to the user
- [x] #3 Different error types have distinct message templates
<!-- AC:END -->
