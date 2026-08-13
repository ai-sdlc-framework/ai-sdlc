---
id: AISDLC-553
title: >-
  feat(design): design-system autonomy-threshold calibrator — corpus aggregator
  + promotion runbook (RFC-0006 OQ-7 resolution)
status: To Do
assignee: []
labels:
  - rfc-0006
  - design-system
  - calibration
  - ci:no-issue-required
priority: low
dependencies: []
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - docs/operations/orchestrator-promotion.md
  - orchestrator/src/design-system-metrics.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implements the tooling half of RFC-0006 OQ-7, resolved 2026-08-13 by operator
walkthrough. §13.2 says every team MUST calibrate autonomy thresholds during
Phase 1 and that the orchestrator SHOULD provide a mode that observes pipeline
operations and recommends initial values. The walkthrough bound that SHOULD to
the framework's existing **corpus-aggregator + promotion-runbook** pattern
rather than inventing a design-specific mechanism, and scheduled the build
behind its data dependency.

**Hard prerequisite — do not start before it is met.** The six `DesignMetrics`
in `orchestrator/src/design-system-metrics.ts` (§A.10) are implemented and
unit-tested but are exported by nothing and imported by nothing. A calibrator
built today would consume nothing and would itself land as unreachable code —
which the dark-code gate now rejects. The wiring is tracked by the separate
"wire the six dark RFC-0006 Addendum A modules" task filed alongside the
Addendum A documentation work; its id is not cross-referenced here because that
task is not yet on `main` and an unresolvable reference fails the DoR gate. Add
the `dependencies:` frontmatter entry once it lands.

## Pattern to follow (do not invent a new one)

Copy the shape of `cli-orchestrator-corpus aggregate` +
`docs/operations/orchestrator-promotion.md`:

- An **append-only metrics corpus** is the input. Records are emitted at hooks;
  nothing is ever hand-written (the RFC-0015 corpus learned this the hard way —
  hand-appended records with invented values had to be deleted).
- An **aggregator** reads the corpus and emits a recommendation envelope:
  `safe-to-promote` / `continue-soak` / `insufficient-data`, with the reason
  string spelling out which floor was not met.
- **Operator-tunable floors** as flags with documented defaults, mirroring
  `--min-tasks` / `--min-distinct-tasks` / `--unattended-threshold`.
- A **`docs/operations/design-system-promotion.md` runbook** documenting both
  the corpus path and the operator-override path, matching the eleven existing
  `*-promotion.md` documents.

The recommendation must be **advisory**: it proposes threshold values inside
each declared `calibrationRange`; the operator applies them. Manual selection
within the range stays conformant, so this must never become a hard gate.

## Scope discipline

Do not widen `calibrationRange` bounds, change any §13.2 template value, or
alter autonomy promotion semantics — this task adds a recommender, not a new
policy. Do not generalise across the other eleven promotion paths; a shared
calibration substrate was explicitly rejected during the walkthrough as
premature abstraction.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Blocked until the six `DesignMetrics` are reachable from a package barrel with at least one real caller; the PR states how that was verified
- [ ] #2 An append-only design-metrics corpus is emitted at instrumentation hooks — no hand-write path exists
- [ ] #3 An aggregator emits `safe-to-promote` / `continue-soak` / `insufficient-data` with a reason string naming the unmet floor, and recommends a threshold value inside each metric's declared `calibrationRange`
- [ ] #4 Floors are operator-tunable flags with documented defaults, following the `--min-tasks` / `--unattended-threshold` convention
- [ ] #5 `docs/operations/design-system-promotion.md` documents the corpus path and the operator-override path, consistent with the eleven existing promotion runbooks
- [ ] #6 The recommender is advisory only — no code path turns it into a merge/promotion gate, and manual selection within `calibrationRange` still passes every check
- [ ] #7 Hermetic tests cover the recommendation envelope's three states, the range-clamping of recommended values, and the insufficient-data path
- [ ] #8 Full verification passes: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`, plus `pnpm dark-code:check` (the new module must be wired, not baselined)
<!-- AC:END -->
