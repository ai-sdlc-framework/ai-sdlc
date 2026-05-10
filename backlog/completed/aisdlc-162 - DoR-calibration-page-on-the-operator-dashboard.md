---
id: AISDLC-162
title: 'DoR calibration page on the operator dashboard'
status: Done
assignee: []
created_date: '2026-05-02'
labels:
  - dashboard
  - dor
  - observability
  - rfc-0011
milestone: m-3
dependencies:
  - AISDLC-161
references:
  - backlog/completed/aisdlc-161 - Wire-up-DoR-calibration-data-collection-in-CI-and-enable-hybrid-Phase-8-promotion-path.md
  - backlog/completed/aisdlc-115 - RFC-0011-Definition-of-Ready-Gate-for-Pipeline-Admission.md
  - pipeline-cli/src/cli/dor-corpus.ts
  - docs/operations/dor-promotion.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes AISDLC-115 parent AC #5: "DoR calibration log feeds metrics
dashboard."

AISDLC-161 shipped the `cli-dor-corpus aggregate` aggregator that reads
N downloaded `_dor/calibration.jsonl` artifacts and produces a per-gate
FP-rate report + recommendation envelope (`safe-to-enforce` /
`continue-soak` / `insufficient-data`). What was missing: an operator
view inside the existing `dashboard/` Next.js app so the same data is
visible in the UI alongside Cost / Autonomy / Audit, not only via a
manual `gh run download` + CLI invocation.

This task adds the `/dor` page. The page reuses the **same** aggregator
code path the CLI uses (no second implementation) by exposing
`pipeline-cli/src/cli/dor-corpus.ts` via a new `./dor-corpus` package
export and wiring `@ai-sdlc/pipeline-cli` as a workspace dep of
`dashboard`. Source-of-truth resolution: `DOR_CORPUS_DIR` env var →
`<cwd>/artifacts/_dor` fallback. When the directory is absent, the
page renders an operator hint pointing at
`docs/operations/dor-promotion.md`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New dashboard page at `dashboard/src/app/dor/page.tsx` (Next.js App Router convention) registered as `/dor`
- [x] #2 Page renders per-gate breakdown (gate id, N, overrides, FP rate, override rate) + aggregate recommendation badge (safe-to-enforce green / continue-soak yellow / insufficient-data gray) + collapsible last-N raw entries table for operator spot-checking
- [x] #3 Data source reuses the AISDLC-161 aggregator (`aggregateCorpus` / `findCalibrationFiles` / `loadCorpus`) via the new `@ai-sdlc/pipeline-cli/dor-corpus` workspace export — single source of truth, no duplicated FP-rate math
- [x] #4 Navigation link added to `coreNavItems` in `dashboard/src/lib/nav-items.ts` so the page is reachable from the existing layout sidebar
- [x] #5 Hermetic test coverage: empty / missing corpus dir, single-file aggregation, continue-soak path with worst-offender gate, freshest-entries-first ordering, multi-file gh-run-download layout, malformed-line skip counter
- [x] #6 Pre-flight passes: `pnpm --filter dashboard build && test` + repo-wide `pnpm lint && pnpm format:check`
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add `./dor-corpus` export to `pipeline-cli/package.json` and
   re-export `CalibrationEntry` from `pipeline-cli/src/cli/dor-corpus.ts`
   so the dashboard can import the aggregator + the entry shape from
   one path.
2. Add `@ai-sdlc/pipeline-cli` as a workspace dep of `dashboard`.
3. Create `dashboard/src/lib/dor-data.ts` — wraps the aggregator with
   source-of-truth resolution (`DOR_CORPUS_DIR` env → `cwd/artifacts/_dor`
   default) and returns the corpus report + freshest-N entries for the
   page.
4. Create `dashboard/src/components/cards/recommendation-badge.tsx` —
   reusable color-coded badge for the three recommendation states.
5. Create `dashboard/src/app/dor/page.tsx` — header, stat cards,
   aggregate section with badge + reason + worst-offender, per-gate
   table, collapsible recent-entries table.
6. Wire `/dor` into `coreNavItems`.
7. Tests: `dor-data.test.ts`, `dor/page.test.tsx`,
   `recommendation-badge.test.tsx`; update `nav-items.test.ts`.
8. Pre-flight + commit.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:SUMMARY:BEGIN -->
## Summary

Shipped the operator-facing `/dor` page on the Next.js dashboard so
AISDLC-161's aggregator output is visible in the UI alongside the
existing Cost / Autonomy / Audit pages. The page reads the corpus from
`DOR_CORPUS_DIR` (or `<cwd>/artifacts/_dor` by default) and reuses the
exact same `aggregateCorpus` / `findCalibrationFiles` / `loadCorpus`
functions the CLI uses by importing from a new
`@ai-sdlc/pipeline-cli/dor-corpus` workspace export — no duplicated
FP-rate math. Closes AISDLC-115 parent AC #5.

## Changes

- `pipeline-cli/package.json` (modified): added `./dor-corpus` export
  pointing at the compiled `dist/cli/dor-corpus.js` so external
  consumers can import the aggregator without going through the CLI
  shim.
- `pipeline-cli/src/cli/dor-corpus.ts` (modified): re-export
  `CalibrationEntry` so consumers get aggregator + entry shape from one
  import path.
- `dashboard/package.json` (modified): added `@ai-sdlc/pipeline-cli`
  workspace dep.
- `dashboard/src/lib/dor-data.ts` (new): `loadDorData()` wrapper +
  `resolveCorpusRoot()` helper. Returns `null` when the dir is absent
  so the page renders a setup hint instead of a stack trace; otherwise
  returns `{ corpusRoot, report, recentEntries }`.
- `dashboard/src/lib/dor-data.test.ts` (new): hermetic coverage —
  resolution order, null path, empty dir, single-file, continue-soak
  worst-offender, freshest-first ordering, recentLimit cap, multi-file
  gh-run-download layout, malformed-line skip counter.
- `dashboard/src/components/cards/recommendation-badge.tsx` (new):
  reusable color-coded badge (green / yellow / gray).
- `dashboard/src/components/cards/recommendation-badge.test.tsx`
  (new): all three variants + n-suffix render.
- `dashboard/src/app/dor/page.tsx` (new): the page itself —
  empty-state hint, stat cards, aggregate-recommendation block,
  per-gate breakdown table (FP rate ≥ 10% highlighted red), collapsible
  recent-entries table.
- `dashboard/src/app/dor/page.test.tsx` (new): mocked `loadDorData`,
  exercises empty / safe-to-enforce / continue-soak / insufficient-data
  paths.
- `dashboard/src/lib/nav-items.ts` (modified): registered
  `{ href: '/dor', label: 'DoR Calibration' }`.
- `dashboard/src/lib/nav-items.test.ts` (modified): asserts the
  6th nav item exists and routes to `/dor`.

## Design decisions

- **Reuse the aggregator, not re-implement** — the dashboard imports
  `aggregateCorpus` from `@ai-sdlc/pipeline-cli/dor-corpus` rather than
  shelling out to the CLI or duplicating the FP-rate math. Single
  source of truth: when AISDLC-115.8 tunes thresholds in the
  aggregator, the dashboard inherits the change with no porting work.
- **Workspace export over child_process** — exposing `dor-corpus` as a
  package subpath keeps the dashboard pure server-side TypeScript
  (no spawn, no JSON-parsing of stdout, no path-to-CLI resolution).
  Trade-off: the dashboard now requires `pipeline-cli` to be built
  (`dist/cli/dor-corpus.js`); this is already true for any workspace
  consumer of pipeline-cli's TS exports and is enforced by the CI's
  `pnpm build` step.
- **`null` return for missing corpus dir, not synthesised empty
  report** — distinguishes "operator hasn't set up corpus" (render the
  `gh run download` hint) from "directory exists but no entries yet"
  (render the natural insufficient-data badge). The empty-aggregate
  shape is reachable via the second path; the null short-circuit only
  fires when the dir is truly absent.
- **`DOR_CORPUS_DIR` env var** — the conventional pattern across the
  pipeline (`ARTIFACTS_DIR`, `AI_SDLC_DB_PATH`). Operators can point
  the dashboard at a `gh run download --pattern dor-calibration-*`
  output without touching the dashboard's start command.
- **Recommendation badge as a separate component** — the same color
  semantics (green/yellow/gray) will appear in the planned RFC-0011
  Phase 5 Slack digest and any future cron summary; extracting now
  beats refactoring later.

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1091 tests passing
  (no aggregator regressions from the `CalibrationEntry` re-export)
- `pnpm --filter dashboard build` — clean (Next.js 15, `/dor` route
  built as dynamic server-rendered)
- `pnpm --filter dashboard test` — 148 tests passing (12 new
  dor-data tests, 5 new badge tests, 4 new page tests, 1 updated
  nav-items test)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up

- Plumb the recommendation envelope into the planned RFC-0011 Phase 5
  Slack digest so the operator gets notified when
  `safe-to-enforce` is reached without having to refresh the dashboard
- Optional GET `/api/dor` JSON route mirroring the page so external
  monitors can poll the recommendation envelope (currently only the
  page surfaces it)
- AISDLC-115.9 owner now has a UI surface to confirm the
  `safe-to-enforce` recommendation before flipping `evaluationMode`
<!-- SECTION:SUMMARY:END -->
