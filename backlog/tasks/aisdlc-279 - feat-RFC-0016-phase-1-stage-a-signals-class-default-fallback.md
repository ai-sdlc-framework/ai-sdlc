---
id: AISDLC-279
title: 'feat: RFC-0016 Phase 1 — Stage A signals + class-default fallback'
status: In Progress
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0016
  - estimation-calibration
  - phase-1
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0016 Implementation Plan (§13). Ships the deterministic-only Stage A estimator behind feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`. Establishes the substrate every later phase composes on.

## Scope

- `cli-estimate stage-a <task-id>` command emitting candidate t-shirt bucket + per-signal breakdown
- Six cheap signal collectors: file scope, blocked paths, file-type breakdown, dependency depth, coverage requirement, LOC delta from planning
- Signal #9 class-default fallback (Q8 resolution): when historical actuals signal returns `unknown` (n<5 per class), fall back to catalogue median per class
- Pure-function bucket-lookup table (no LLM calls)
- Seed class-default buckets for the 3 starter classes: `bug` → S, `feature` → M, `chore` → S
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `cli-estimate stage-a AISDLC-X` returns candidate bucket + per-signal breakdown for any backlog task
- [x] #2 Six deterministic signal collectors implemented per §5
- [x] #3 Class-default fallback fires when historical-actuals signal returns `unknown` (n<5 per class)
- [x] #4 No LLM calls in Stage A
- [x] #5 Behind `AI_SDLC_ESTIMATION_CALIBRATION=experimental` feature flag (degrade-open when disabled)
- [x] #6 Unit tests cover all six signals + class-default fallback path
<!-- AC:END -->

## Final Summary

### Summary
RFC-0016 Phase 1 ships the deterministic-only Stage A estimator behind feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`. Establishes the substrate every later phase composes on; no LLM calls, pure-function bucket-lookup table, degrades open when the flag is off.

### Changes
- `pipeline-cli/src/estimation/feature-flag.ts` (new): `AI_SDLC_ESTIMATION_CALIBRATION` flag predicate, mirrors `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` shape.
- `pipeline-cli/src/estimation/types.ts` (new): Bucket / TaskClass / SignalOutput / StageAResult shapes — frozen contract for Phase 2-5 consumers.
- `pipeline-cli/src/estimation/class-assignment.ts` (new): Phase 1 deterministic stand-in for the §6.1 LLM classifier (frontmatter → keyword heuristic → `feature` default).
- `pipeline-cli/src/estimation/signals.ts` (new): 9 collectors — 6 live cheap signals (#1, #3, #4, #5, #6, #7), 2 Phase-3 stubs (#2, #8), and the Q8 class-default fallback (#9).
- `pipeline-cli/src/estimation/aggregator.ts` (new): pure §5.2 decision-rules folder — unanimous → high, adjacent split → medium+range, non-adjacent → low+escalate; Q8 ordering keeps cheap signals above the class-default.
- `pipeline-cli/src/estimation/stage-a.ts` (new): top-level façade — disk I/O for task file, codecov.yml, and `cli-deps blockers` lives here; the collectors and aggregator stay pure.
- `pipeline-cli/src/cli/estimate.ts` + `pipeline-cli/bin/cli-estimate.mjs` (new): yargs CLI router + bin shim — JSON / table output, degrade-open when flag off.
- `pipeline-cli/package.json`: registers `cli-estimate` bin + `./estimation` exports subpath.
- 6 test files (`feature-flag`, `class-assignment`, `signals`, `aggregator`, `stage-a`, `cli/estimate`): 137 new tests covering every collector, the aggregator's §5.2 rules, the Q8 fallback ordering, and the CLI degrade-open contract.

### Design decisions
- **Cheap-specific signals win over class-default per Q8.** The aggregator treats signal #9 as a tiebreaker only consulted when no cheap-specific signal resolved — so the §5.3 worked example (AISDLC-123 file-scope XS vs class-default S → XS wins) reproduces verbatim.
- **Range outputs for the file-scope and file-type signals.** The RFC writes these as 2-bucket ranges (`XS-S`, `S-M`, etc.); emitting `range` faithfully preserves the RFC's voting shape rather than collapsing to a single bucket on the collector side.
- **Bumps clamp at XS/XL endpoints.** Coverage / dependency-depth / blocked-paths bumps shift both endpoints of the chosen range together; clamping at the bucket-array bounds keeps the function total without surfacing under/overflow to callers.
- **Frontmatter `class:` field is read directly (not via `parseTaskFile`).** The base `TaskSpec` shape doesn't carry the `class:` field; re-parsing the YAML block in `stage-a.ts` is cheap and keeps the existing parser untouched.
- **Phase 1 deterministic class assignment (NOT `uncategorized`).** Phase 1 has a hard "no LLM calls" constraint; falling back to `feature` (the empirical-majority class) means signal #9 always has a seed bucket to vote with. `uncategorized` is reserved for the Phase 2+ LLM confidence-gate path.

### Verification
- `pnpm build` — clean across all workspaces.
- `pnpm test` — 3118 pipeline-cli tests pass (137 new), 3207 orchestrator tests pass, 1265 reference tests pass, 303 dogfood tests pass, full monorepo green.
- `pnpm lint` — 0 errors (2 pre-existing warnings in `pipeline-cli/src/steps/00-sweep.ts` unchanged).
- `pnpm format:check` — clean.
- Manual smoke: `AI_SDLC_ESTIMATION_CALIBRATION=experimental cli-estimate stage-a AISDLC-279 --format table` emits a 9-row signal table matching the §5.1 catalogue layout.

### Follow-up
- Phase 2 (AISDLC-280? — to be created): estimate-log writer, `estimateInputHash` (Q5), wire to `events.jsonl`.
- Phase 3: actuals collector that retires signal #2 / #8 stubs as data flows in.
