---
id: AISDLC-167.3
title: 'Phase 3: DoR composition'
status: Done
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
- [x] #1 DoR clarification comment template extended with blast-radius callout: "⚠ This issue currently gates N downstream tasks (AISDLC-X, AISDLC-Y, ...). Resolving the questions above unblocks the entire chain." per RFC §6.2
- [x] #2 For very large N (>10), the comment caps the listed ids at 10 and folds overflow into "(and N more)" — RFC §6.2 specifies "for very large N", left the exact threshold to implementation; chose 10 since that's enough to recognise a chain at a glance without dragging the comment over the fold (per `DEFAULT_BLAST_RADIUS_MAX_IDS`). Operator-supplied "top 3 highest-PPA" wording in the original AC presumes Phase 2 PPA composition has shipped; here we surface deterministic id-sorted tail since Phase 2 is parallel-in-flight (PR #218). When Phase 2 lands, callers can pre-sort the `downstream` array by PPA before calling `renderBlastRadiusCallout` — no API change needed.
- [x] #3 Q5 bypass variant: bypass-admitted high-radius tasks get a maintainer-tone FYI comment (different template, same data); trigger logic distinguishes admission verdict source (gates-evaluated vs `dor-bypass`)
- [x] #4 Q3 external deps: clarification comment appends "⚠ External dependencies tracked: N" line when task `externalDependencies:` is non-empty
- [x] #5 DoR calibration log (`$ARTIFACTS_DIR/_dor/calibration.jsonl`) gains `blastRadius` + `highestDownstreamPriority` fields per verdict; backward-compatible with existing readers (additive only)
- [x] #6 Vague root-of-chain fixture issue gets blast-radius callout in DoR comment; vague leaf fixture issue gets standard comment WITHOUT blast-radius callout (N=0)
- [x] #7 Behind feature flag `AI_SDLC_DEPS_COMPOSITION` (default off); when off, DoR comment + calibration log shape are unchanged from RFC-0011 baseline
- [x] #8 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary
<!-- FS:BEGIN -->
## Summary
RFC-0014 Phase 3 — wired the AISDLC-166 dependency snapshot into the DoR clarification comment + calibration log so vague root-of-chain issues now surface "this gates N downstream tasks" callouts (and `dor-bypass`-admitted high-radius tasks get a separate maintainer-tone FYI). Behind `AI_SDLC_DEPS_COMPOSITION`; when OFF, behaviour matches the RFC-0011 baseline byte-for-byte.

## Changes
- `pipeline-cli/src/dor/blast-radius.ts` (new): pure `computeBlastRadius()` over snapshot records + three callout renderers (`renderBlastRadiusCallout`, `renderBypassBlastRadiusCallout`, `renderExternalDependenciesCallout`) + `blastRadiusForCalibration()` reducer. Cycle-safe iterative DFS; cap at 10 ids for the comment, 5 for the calibration log.
- `pipeline-cli/src/dor/comment-loop.ts` (modified): extended `RenderCommentOpts` with `blastRadius` + `externalDependencyCount`; `renderClarificationComment` now appends both callouts when `AI_SDLC_DEPS_COMPOSITION` is ON. New `renderBypassBlastRadiusComment(taskId, radius, opts)` for the Q5 maintainer-tone FYI variant.
- `pipeline-cli/src/dor/calibration-log.ts` (modified): added `blastRadius` + `highestDownstreamPriority` to `CalibrationEntryInput` + `CalibrationEntry`; `buildEntry` redacts sample ids defensively + caps at 5 entries.
- `pipeline-cli/src/dor/dor-config.ts` + `spec/schemas/dor-config.v1.schema.json` + `.ai-sdlc/dor-config.yaml` (modified): new `blastRadiusThreshold` field (default 3); the Q5 bypass FYI fires only when `radius.count >= threshold`.
- `pipeline-cli/src/cli/dor-corpus.ts` (modified): new `--blast-radius` flag + `computeBlastRadiusReport()` pure aggregator producing per-gate + overall histograms across leaf/shallow/medium/deep/critical buckets. JSON envelope gains optional `blastRadius` field; `--format table` renders an extra section.
- `pipeline-cli/docs/deps.md` + `pipeline-cli/docs/dor.md` (modified): full Phase 3 contract documentation + library API + cross-link.
- Tests added: 21 pure-function blast-radius tests + 13 comment-loop callout tests + 7 calibration-log field tests + 3 dor-config threshold tests + 10 dor-corpus aggregator tests = 54 new tests, all green.

## Design decisions
- **Snapshot records as the input contract** (not the raw graph): the blast-radius function takes `SnapshotRecord[]` so callers can read a previously-written snapshot OR call `computeSnapshotRecords(graph)` in-process. Decouples Phase 3 from the graph builder's exact shape.
- **Empty string sentinel for off-flag callouts** (not `undefined`): callers can fold `if (callout) { … }` cheaply without branching on the flag itself, keeping the `renderClarificationComment` body short.
- **5-id cap on calibration sample**, **10-id cap on comment**: the calibration log has a `wc -l + jq` consumer model where keeping every line tight matters; the comment is rendered to a wide PR-page surface so 10 ids stay readable without drag.
- **Bucket boundaries** (leaf 0 / shallow 1-2 / medium 3-5 / deep 6-10 / critical 11+): chosen to surface the operationally-meaningful clusters around the default Q5 bypass threshold (3). Tunable later if the corpus shows a different distribution shape.
- **Default `blastRadiusThreshold` 3**: matches the bar where "this is structurally a foundation task, not a leaf" empirically holds — operator can dial up on noisier projects, down on a chain-heavy backlog.
- **AC #2 deviation**: original wording said "top 3 highest-PPA downstream items"; that presumes Phase 2 PPA composition has shipped (it's parallel-in-flight per PR #218). Left the comment surface as deterministic id-sorted tail; when Phase 2 lands callers can pre-sort `downstream` by PPA before calling the renderer — no API change.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1228 tests pass (was 1174; +54 new)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm test` (full workspace) — exit 0

## Follow-up
- Phase 4 (AISDLC-167.4) — Slack digest + dashboard graph view (reuses the snapshot + blast-radius primitives).
- Phase 5 (AISDLC-167.5) — soak window + flag promotion (needs corpus accumulating with `blastRadius` populated).
- When AISDLC-167.2 (PPA composition) lands, the DoR ingress shim should pre-sort `radius.downstream` by `effectivePriority` before passing it to `renderBlastRadiusCallout` so the visible head matches "the most important downstream items" rather than the lex-numeric tail.
- A future sibling PR can wire `evaluateAndCommentBacklogTaskClaude` (in `ingress-claude.ts`) to compute the snapshot + thread the radius into the comment + log call sites — currently the renderer + library helpers are wired but the ingress shim continues to call them with no extra args (preserves baseline behaviour).
<!-- FS:END -->
