---
id: AISDLC-769
title: >-
  Clock discipline: lint rule, test convention and reviewer check for time-dependent tests
status: Done
assignee: []
created_date: '2026-10-09'
labels:
  - testing
  - lint
  - governance
dependencies: []
references:
  - eslint.config.mjs
  - pipeline-cli/src/usage/pane-data.ts
  - pipeline-cli/src/tui/panes/usage.test.tsx
  - ai-sdlc-plugin/agents/test-reviewer.md
  - .ai-sdlc/review-policy.md
  - docs/audits/2026-10-09-clock-dependent-test-red-main-rca.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

AISDLC-767: a test fixed its data timestamp (2026-09-10) but rendered through code that read the real clock, so it passed for 28 days and then failed on every run, turning main red with no code change. Today 248 non-test source files across pipeline-cli, orchestrator, reference and the MCP server call `new Date()` or `Date.now()` directly, and 289 test files use fixed 2026 timestamps. RCA: `docs/audits/2026-10-09-clock-dependent-test-red-main-rca.md`.

## Scope

1. ESLint `no-restricted-syntax` for `new Date()` (no arguments) and `Date.now()` in `src/**` outside a per-package `clock.ts` seam (`now(): Date`, injectable). Warn level with a shrink-only baseline file, the same ratchet model as `.ai-sdlc/dark-code-baseline.json`; new call sites fail.
2. Test convention in `docs/contributing` (or the nearest testing guide): a test that writes a fixed timestamp must also fix the clock, via `vi.useFakeTimers({ now })` or the module's `now` seam. A vitest setup helper `withFixedClock(iso, fn)` for the common case.
3. Test-reviewer agent checklist line: "A test that fixes a timestamp and does not fix the clock is a major finding." This edit touches a plugin agent definition, so the PR body carries a Velocity impact section per DEC-0048 (expected cost: one extra grep per review, no new blocking prompt).
4. Migrate the usage pane and usage loader tests to the convention as the worked example.

Sequencing: none. AISDLC-767 ships the immediate fix; this task prevents the class.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: `pnpm lint` fails on a new direct `Date.now()` in `src/**` outside the seam and passes on the baseline.
- [ ] AC-2: The baseline file can only shrink; a test asserts this.
- [ ] AC-3: The test-reviewer agent flags a fixed-timestamp test without a fixed clock, shown by a fixture in the agent's tests.
- [ ] AC-4: New and existing tests pass.
<!-- AC:END -->
