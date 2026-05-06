---
id: AISDLC-178.1
title: >-
  Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder
  panes
status: Done
assignee: []
created_date: '2026-05-04 02:02'
updated_date: '2026-05-05 22:15'
labels:
  - rfc-0023
  - phase-1
  - skeleton
dependencies: []
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - pipeline-cli/
  - pipeline-cli/package.json
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0023 implementation (RFC §13 Phase 1, ~3-5 days).

Foundational scaffold that all subsequent phases build on. Ships the binary, the Ink-based render loop, and the Overview Mode pane skeleton with placeholder content. No real data sources yet — Phase 2 wires those in.

Per RFC OQ-1 resolution: Ink (React-for-CLI, ESM). Component model matches the §7 pane layout.

Per RFC §6.3: TUI lives in `pipeline-cli/src/tui/` with binary at `pipeline-cli/bin/cli-tui.mjs`. Same package as the orchestrator (shares types, builds + ships in same npm publish cycle).

Per RFC §14: gated behind `AI_SDLC_TUI=experimental` feature flag — when unset, `cli-tui` exits with "not enabled" message + pointer to promotion runbook.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pipeline-cli/bin/cli-tui.mjs binary exists, registered in pipeline-cli/package.json bin field
- [x] #2 Ink dependency added to pipeline-cli/package.json (latest stable)
- [x] #3 Feature flag AI_SDLC_TUI=experimental gates startup; unset → exits with 'not enabled' message
- [x] #4 Overview Mode renders with 5 placeholder panes (Blockers top-left, PRs top-right, Critical Path bottom-left, Analytics bottom-right, Events full-width bottom) per RFC §7 layout
- [x] #5 Footer renders mode keys [b] [p] [d] [c] [a] [/] [q] [r] [?]
- [x] #6 Ctrl+C exits cleanly
- [x] #7 q keystroke exits cleanly
- [x] #8 Empty-state copy uses '✓ No decisions pending — pipeline self-driving' per OQ-9 resolution
- [x] #9 Unit tests cover: feature-flag gate, exit handlers, pane rendering smoke test (Ink testing utilities)
- [x] #10 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

## Summary
Phase 1 of RFC-0023 TUI shipped: the `cli-tui` binary, Ink-based render loop, and Overview Mode skeleton with 5 placeholder panes (Blockers, PRs, Critical Path, Analytics, Events). Gated behind `AI_SDLC_TUI=experimental`. All 10 ACs met. Implementation was merged to main via commit 2d723d2 (PR context). This closure PR moves the task to completed state.

## Changes
- `pipeline-cli/bin/cli-tui.mjs` (new): bin shim that imports from `dist/tui/index.js`
- `pipeline-cli/src/tui/index.ts` (new): entry point with feature-flag check + Ink render launch
- `pipeline-cli/src/tui/feature-flag.ts` (new): AI_SDLC_TUI predicate, truthy set mirrors RFC-0015 pattern
- `pipeline-cli/src/tui/app.tsx` (new): root Ink component with 5-pane layout + q-key exit handler
- `pipeline-cli/src/tui/footer.tsx` (new): 9 keystroke labels [b][p][d][c][a][/][r][?][q]
- `pipeline-cli/src/tui/panes/*.tsx` (5 new): placeholder panes with OQ-9 empty-state copy in Blockers
- `pipeline-cli/src/tui/feature-flag.test.ts` (new): 23 tests covering truthy/falsy, case, whitespace
- `pipeline-cli/src/tui/app.test.tsx` (new): 7 tests covering pane renders, empty-state copy, keystroke routing

## Design decisions
- **handleAppKey extracted from component**: allows unit testing keystroke routing without Ink raw-mode stdin shim
- **Panes as separate files**: clean structure for Phase 3-6 to replace placeholders without touching other panes
- **ESM dynamic import for Ink**: defers React/Ink parse cost when flag is OFF

## Verification
- `pnpm build` — clean
- `pnpm test` — 1799 tests passed (109 test files)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Coverage: 98.7% on src/tui (lines); 95.05% overall — above 80% threshold

## Follow-up
- Phase 2 (AISDLC-178.2): wire data sources (events.jsonl tail, gh PR cache, dep-snapshot reader, cli-status poller, backlog walker)
