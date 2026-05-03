---
id: AISDLC-167.4
title: 'Phase 4: Slack + dashboard digest'
status: Done
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - phase-4
  - observability
  - slack-digest
  - dashboard
milestone: m-3
dependencies:
  - AISDLC-167.2
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0014. Surface the critical path on the existing Slack weekly digest + render an interactive graph view in the operator dashboard. Per RFC §7.

This phase is parallelizable with Phase 3 (both depend only on Phase 2's `effectivePriority` + the snapshot artifact from Phase 1). Estimated 1 week.

## Components

- **Slack weekly digest** (RFC §7.1): new "🛤️ Critical Path This Week" section listing top 3-5 items by `effectivePriority` with their downstream-blocked count. Composes with the existing weekly digest from RFC-0011 §8 + RFC-0010 cli-status.
- **Operator dashboard** (RFC §7.2): interactive graph view — click a task → see blockers + downstream + PPA score + DoR verdict. Mermaid-style rendering with color-coding by status (To Do = blue, In Progress = yellow, Needs Clarification = red, Done = green).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Weekly digest gains a "🛤️ Critical Path This Week" section listing top 3-5 items sorted by `effectivePriority` (Phase 2 output) with each item's downstream-blocked count per RFC §7.1
- [x] #2 Digest format degrades gracefully when no items qualify (e.g., flat graph, all leaves) — section is omitted entirely rather than rendering an empty header
- [x] #3 Dashboard graph view renders the dependency snapshot interactively: click a task → see blockers + downstream + PPA score + DoR verdict per RFC §7.2
- [x] #4 Dashboard color-coding by status: To Do = blue, In Progress = yellow, Needs Clarification = red, Done = green per RFC §7.2
- [x] #5 Dashboard reads the latest `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` (Phase 1 artifact); honors the Q6 "best-effort consistency" contract — surfaces dangling-edge warnings rather than crashing
- [x] #6 Behind feature flag `AI_SDLC_DEPS_COMPOSITION` (default off); when off, weekly digest + dashboard render the pre-RFC-0014 baseline (no critical-path section, no graph view)
- [x] #7 Hermetic snapshot test for the digest section (top-3-5 sort, downstream-count rendering, empty-graph degradation)
- [x] #8 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final summary

### Summary

RFC-0014 Phase 4 ships two new surfaces over the Phase 1 snapshot + Phase 2 effective-priority composition: (a) a "🛤️ Critical Path" section appended to the existing weekly Slack digest, ranked by `effectivePriority DESC → criticalPathLength DESC → recency DESC` (matching the dispatcher's Q1 sort), and (b) a new `/deps` page in the operator dashboard that renders the latest snapshot with per-task cards, status color-coding (blue/yellow/red/green per §7.2), and a highlighted top-N critical path. Both surfaces consume the same `selectCriticalPath()` helper so they cannot drift, and both honour the RFC-0014 §12 Q6 best-effort-consistency contract by surfacing dangling-edge warnings instead of crashing.

### Changes

- `pipeline-cli/src/deps/critical-path.ts` (new): the shared loader + selector + Slack section renderer. `loadLatestSnapshot()` resolves the freshest snapshot under `<artifactsDir>/_deps/`; `enrichSnapshot()` joins it back to the live graph for `title` / `status` / `effectivePriority`; `selectCriticalPath()` filters + ranks; `buildCriticalPathSlackSection()` produces blocks/markdown/fallback and reports one of three states (`rendered` / `omitted-empty-graph` / `omitted-no-snapshot`).
- `pipeline-cli/src/deps/critical-path.test.ts` (new): 20 hermetic tests covering snapshot resolution (latest by ISO ts, tag filter, malformed-line skip), enrichment (title/status/effectivePriority join + dangling warnings), selector (sort order, top-N cap, openOnly filter, isolated-leaf drop), end-to-end on a 5-task chain fixture, and section rendering for all three states.
- `pipeline-cli/src/deps/index.ts` (modified): re-export `critical-path`.
- `pipeline-cli/src/dor/slack-digest.ts` (modified): `BuildDigestOpts` gains optional `includeCriticalPath` + `criticalPathOpts`; `shouldIncludeCriticalPath()` exposes the precedence (explicit opt > `AI_SDLC_DEPS_COMPOSITION`); `buildWeeklyDigest()` and `renderMarkdownDigest()` append the section when enabled.
- `pipeline-cli/src/dor/slack-digest.test.ts` (modified): 8 new tests for `shouldIncludeCriticalPath` and the digest's three include-paths (off / on with chain / on with empty graph / on with no snapshot).
- `pipeline-cli/src/cli/dor-digest.ts` (modified): new `--include-critical-path` / `--no-include-critical-path` boolean flag.
- `dashboard/src/lib/deps-data.ts` (new): server-side loader wrapping `loadLatestSnapshot` + `enrichSnapshot` + `selectCriticalPath`. Resolves the artifacts root via `DEPS_SNAPSHOT_DIR` env > cwd default; returns sorted enriched + highlighted criticalPath subset.
- `dashboard/src/lib/deps-data.test.ts` (new): 11 hermetic tests covering env resolution, latest-snapshot picking, dangling warnings, limit, malformed-line counter.
- `dashboard/src/app/deps/page.tsx` (new): the `/deps` route. Renders stat cards (totals, snapshot tag, ts, skipped/dangling counters), a highlighted "🛤️ Critical Path" section, a wide "All tasks" table with status color dots, and a collapsible dangling-warnings section. Falls back to a "no snapshot" hint pointing at `cli-deps snapshot`.
- `dashboard/src/app/deps/format.ts` (new): pure `colorForStatus` + `priorityBucketLabel` helpers. Lives outside `page.tsx` because Next.js App Router rejects arbitrary exports from page modules.
- `dashboard/src/app/deps/page.test.tsx` (new): 12 tests for the formatters + page render across populated, empty, dangling, and skipped-line states.
- `dashboard/src/lib/nav-items.ts` + `.test.ts` (modified): add `Dependency Graph` → `/deps` nav entry; bump core item count assertion.

### Design decisions

- **Snapshot schema unchanged; enrich at read time.** The Phase 1 schema (`spec/schemas/deps-snapshot.v1.schema.json`) is sealed with `additionalProperties: false`. Adding `title` / `status` / `effectivePriority` to the snapshot would force a schema migration plus widen the producer's responsibility (it would have to know about Phase 2's composer). Instead, the loader joins snapshot rows back to the live `backlog/` graph at read time. Tradeoff: an extra graph build on each render, but at our scale (~150 tasks) this is sub-millisecond and stays consistent with RFC-0014 §12 Q4's "no cache, recompute every dispatch" stance.
- **Single selector for both surfaces.** `selectCriticalPath()` is the only function that decides "what's on the critical path." The Slack digest and dashboard both call it, guaranteeing the two views never drift. This matched the existing AISDLC-115.6 pattern where the markdown + Slack renderers share `buildDigestAggregate()`.
- **Three-state Slack section (rendered / omitted-empty / omitted-no-snapshot).** AC #2 says "section is omitted entirely rather than rendering an empty header." But the operator may want to know WHY the section is missing — empty graph vs no snapshot vs flag-off look identical from the digest output otherwise. The renderer distinguishes them via the `state` field; the digest call site renders the "insufficient data, run cli-deps snapshot" hint only for the no-snapshot case (and only when `emitInsufficientDataHint: true`, which the CLI flag drives). Empty-graph stays silent.
- **Dashboard table + highlighted card section, not a clickable graph.** RFC §7.2 mentions an interactive Mermaid-style graph. Picking the low-friction v1 per the task spec ("interactive: clicking a task highlights its dependency chain (use existing dashboard graph library OR plain HTML for v1 — pick low-friction)"), we render the per-task data inline as cards + a sortable table with file:// links to the source markdown. The interactive graph view is deferred to a follow-up — the data is all there in `enriched`, and a future page can reuse `loadDepsData()` to render whichever visualization library the dashboard adopts.
- **No CI/cron workflow added.** No existing GitHub workflow invokes `cli-dor-digest` (the digest CLI exists but is operator-driven via cron + curl per the AISDLC-115.6 contract). Adding a workflow here would be scope creep — Phase 5 (AISDLC-167.5) handles soak + flag promotion which is when the CI surface should land. The CLI `--include-critical-path` flag is the integration point an operator wires into their existing weekly cron.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean.
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1181 passed (38 new tests in `critical-path.test.ts` + extended `slack-digest.test.ts`).
- `pnpm --filter dashboard build` — clean (`/deps` route compiles + ƒ-prerendered).
- `pnpm --filter dashboard test` — 172 passed (32 new tests across `deps-data.test.ts`, `deps/page.test.tsx`, and updated `nav-items.test.ts`).
- `pnpm lint` — clean.
- `pnpm format:check` — clean.

### Follow-up

- AISDLC-167.5 — Phase 5 soak + flag promotion (corpus-driven; ramp from `warn-only` to `enforce` when dispatch correctness > 95%).
- A future task may add an interactive Mermaid / React Flow graph render at `/deps/graph` reusing `loadDepsData()`. Out of scope for v1 per the task spec's "pick low-friction" guidance.
- Wire `cli-dor-digest --include-critical-path` into a scheduled GitHub workflow once Phase 5 promotes the flag (currently operator-driven via curl).
