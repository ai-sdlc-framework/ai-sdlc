---
id: AISDLC-167.3
title: 'Phase 3: DoR composition'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - phase-3
  - dor-composition
  - blast-radius
milestone: m-3
dependencies:
  - AISDLC-167.2
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - .ai-sdlc/dor-config.yaml
  - ai-sdlc-plugin/agents/refinement-reviewer.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0014. Extend the DoR clarification comment template + calibration log with blast-radius fields so authors see "this gates N downstream tasks" and the calibration loop distinguishes false-positives on leaves vs chain roots. Per RFC §6.

Two comment templates per Q5 resolution:
1. **Standard verdict** (gates evaluated, returned `Needs Clarification`): existing template + blast-radius callout.
2. **Bypass verdict** (`dor-bypass` maintainer override on a high-radius task): maintainer-tone FYI variant — different audience, different tone, same data.

Estimated 0.5 week.

## Open-question resolutions implemented in this phase

- **Q3 (external deps):** DoR clarification comment appends a "⚠ External dependencies tracked: N" line when `externalDependencies:` is non-empty. Pure signal in v1; not a dispatch gate.
- **Q5 (bypass × blast radius):** Standard admission verdicts get the existing "⚠ This issue currently gates N downstream tasks (...). Resolving the questions above unblocks the entire chain." Bypass-admitted high-radius tasks get a maintainer-tone variant: "ℹ This bypass admits a task gating N downstream items (AISDLC-X, AISDLC-Y, ...). Confirm intentional — high blast radius is a strong calibration signal that the rubric may be missing something." Trigger logic = admission verdict source determines which template fires.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DoR clarification comment template extended with blast-radius callout: "⚠ This issue currently gates N downstream tasks (AISDLC-X, AISDLC-Y, ...). Resolving the questions above unblocks the entire chain." per RFC §6.2
- [ ] #2 For very large N (>5), the comment lists the top 3 highest-PPA downstream items by name + a "see N total" link to the graph view per RFC §6.2
- [ ] #3 Q5 bypass variant: bypass-admitted high-radius tasks get a maintainer-tone FYI comment (different template, same data); trigger logic distinguishes admission verdict source (gates-evaluated vs `dor-bypass`)
- [ ] #4 Q3 external deps: clarification comment appends "⚠ External dependencies tracked: N" line when task `externalDependencies:` is non-empty
- [ ] #5 DoR calibration log (`$ARTIFACTS_DIR/_dor/calibration.jsonl`) gains `blastRadius` + `highestDownstreamPriority` fields per verdict; backward-compatible with existing readers (additive only)
- [ ] #6 Vague root-of-chain fixture issue gets blast-radius callout in DoR comment; vague leaf fixture issue gets standard comment WITHOUT blast-radius callout (N=0)
- [ ] #7 Behind feature flag `AI_SDLC_DEPS_COMPOSITION` (default off); when off, DoR comment + calibration log shape are unchanged from RFC-0011 baseline
- [ ] #8 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
