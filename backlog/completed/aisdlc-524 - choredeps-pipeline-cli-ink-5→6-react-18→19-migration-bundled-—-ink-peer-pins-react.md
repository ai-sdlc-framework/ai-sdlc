---
id: AISDLC-524
title: >-
  chore(deps): pipeline-cli ink 5→6 + react 18→19 migration (bundled — ink
  peer-pins react)
status: In Progress
assignee: []
created_date: '2026-06-08 16:37'
labels:
  - dependencies
  - chore
  - 'ci:no-issue-required'
dependencies: []
references:
  - pipeline-cli/package.json
  - pipeline-cli/src/tui
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to AISDLC-523 (which landed github-actions + commitlint + TypeScript 5→6 but ESCALATED react). The react 18→19 bump for `pipeline-cli` is blocked because pipeline-cli uses `ink@5.x`, whose peer dependency pins `react@^18.3.1`. So react and ink must be bumped together: `ink 5→6` (ink 6 requires react >= 19) + `react 18→19` + `react-dom` + `@types/react(-dom)` to matching 19.x.

Scope is `pipeline-cli` ONLY — the `dashboard/` package is already on react 19 and builds green; do NOT touch it. This supersedes the react portion of the stuck dependabot PRs #786 / #836 for pipeline-cli.

Migration work to expect:
- ink 5→6 breaking changes: ink 6 is ESM-only and dropped some APIs / changed render/exit semantics — audit pipeline-cli's ink-based TUI components (the `tui/` rendering code) for removed/renamed exports and the `render()` return shape.
- react 19 breaking changes in the TUI: ref-as-prop (forwardRef no longer needed), removed legacy APIs, stricter `useRef`/effect typing under TS 6.
- Keep react + react-dom at the EXACT same 19.x version (pnpm-lock must resolve them identically).

If ink 6 surfaces breaking changes that require non-trivial TUI rework beyond a mechanical bump, land what builds green and escalate the remainder with notes rather than shipping a broken pipeline-cli TUI.

Note: AISDLC-523 (#877) also touches pipeline-cli/package.json (TypeScript bump). If #877 has merged by the time this lands, rebase onto it; if not, expect a trivial package.json rebase. This task does not hard-depend on #877.

References: the react/ink versions live in pipeline-cli/package.json; TUI source under pipeline-cli/src/tui/.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-cli/package.json: ink bumped to ^6.x, react + react-dom bumped to the SAME 19.x version, @types/react(-dom) matching 19.x; pnpm-lock.yaml resolves react and react-dom to identical versions with no peer-dependency warnings
- [ ] #2 pipeline-cli TUI code (src/tui/**) migrated for ink 6 + react 19 breaking changes (ESM-only ink, render/exit semantics, ref-as-prop); no removed/renamed ink-6 API left referenced
- [ ] #3 pnpm build (tsc) passes for pipeline-cli with no new type errors under TS + react 19 types
- [ ] #4 pnpm --filter @ai-sdlc/pipeline-cli test passes (TUI tests included); pnpm lint + format:check clean
- [ ] #5 dashboard/ is NOT modified (already react 19)
- [ ] #6 If ink 6 requires non-trivial TUI rework that cannot be completed cleanly, the unfinished portion is escalated (prUrl:null + notes) rather than shipping a broken TUI
<!-- AC:END -->
