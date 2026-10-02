---
id: AISDLC-635
title: >-
  RFC-0049 Group A: decision reversibility, pillars, duplicate, Stage B signals, and estimation class judgments
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-4
  - decisions
  - estimation
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/decisions/stage-a.ts
  - pipeline-cli/src/decisions/stage-b.ts
  - pipeline-cli/src/estimation/class-assignment.ts
  - .ai-sdlc/decision-exemplars.yaml
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replaces keyword heuristics and two hard-coded constants with judgments, keeping each
heuristic as the fallback. RFC-0049 section 5, Group A. Today: reversibility is a list
of 14 phrases; pillar tagging matches substrings such as `ci` and `ui` inside longer
words; duplicate detection is edit distance; Stage B sets `novelty` and
`exemplarSimilarity` to a constant 0.5; estimation class is a title-prefix regex whose
own comment calls it a stand-in for a classifier.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`. Its Open Questions
  are resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No vendor SDK and no new runtime dependency. HTTP goes through an injectable `fetch`;
  tests never touch the network.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
**Amended after review:** the literal forms of items 1, 2 and 4 would have let a judgment
reduce review (a judged `reversible` auto-deciding, pillar replacement removing sign-offs, raised Stage B
scores moving a decision into the Stage C auto-apply band), which a `seam` definition
must not do (its `reducesReview` is `false`). The conservative semantics below replace them. Every gating read
of the Stage B score, Stage C band, auto-apply eligibility and the framework route uses a baseline run with no
judged input; the judged run is display and scoring only. All five definitions: `egressClass`
`work-item-text`, `riskClass` `seam`, `direction` `bidirectional`, `fallback` `pending`,
`reducingOutcomes` `[]`, `reducesReview` `false`. In every case the existing heuristic result is passed to
`evaluateJudgment` as the `incumbent` and is what the caller uses on `abstain`.

1. **`decision.reversibility`** (`pipeline-cli/src/decisions/stage-a.ts`): Choice over
   `reversible`, `one-way`, `unknown`. Amended semantics: a judged `one-way` replaces
   `unknown` only (more scrutiny). A judged `reversible` is recorded in the new
   `judgedReversibility` field and gates nothing; the gating value stays `unknown`. A
   phrase-list or explicit hit is always kept, including a `one-way` hit when the
   judgment says `reversible`.
2. **`decision.pillars`** (same file): one Noul per pillar (engineering, product,
   design), since several can apply. Amended semantics: judged pillars are added to the
   keyword result (union only); a judged pillar never removes a keyword pillar; an empty
   set falls back to the keyword result.
3. **`decision.duplicate`** (same file): the existing edit-distance pass produces a
   shortlist; one Noul per shortlisted pair, all pairs in one request, asks whether the
   two summaries describe the same decision. Permissive outcome: declaring a duplicate.
4. **`decision.stage-b-signals`** (`pipeline-cli/src/decisions/stage-b.ts`): two Score
   questions with four described levels each, one for novelty against the exemplar
   history and one for similarity to labelled exemplars, with the relevant exemplars
   from `.ai-sdlc/decision-exemplars.yaml` in the state. Each score is normalised to
   0..1 by dividing the level position by 3 and replaces the constant 0.5 in the
   existing weighted formula. Amended semantics: each signal is capped at 0.5 (only
   levels 0 and 1 take effect); on `abstain` the constants remain 0.5.
5. **`estimate.class`** (`pipeline-cli/src/estimation/class-assignment.ts`): Choice
   over `bug`, `feature`, `chore`, `uncategorized`. Resolution order becomes
   frontmatter, then judgment (`act` only), then the existing regex, then default.
   `AssignClassResult.source` gains the value `judgment`.

6. **Capability ids:** `decision.stage-b-signals` sets `capabilityId`
   `decisions.stage-b-signals` and `estimate.class` sets `estimation.class-assignment`
   (RFC-0049 section 9.1). The other three definitions set none.

## Acceptance Criteria
- [x] With the layer disabled, the outputs of reversibility, pillar tagging, duplicate detection, Stage B scoring and class assignment are unchanged on their existing test fixtures.
- [x] `decision.reversibility` in `enforce` replaces `unknown` with `one-way`, never promotes to `reversible` (recorded only), and a keyword `one-way` hit survives a judgment answer of `reversible`.
- [x] `decision.pillars` adds judged pillars to the keyword result (union only, never removing one) and falls back to the keyword result when none clear the threshold.
- [x] `decision.duplicate` sends all shortlisted pairs in one provider request and makes no request when the shortlist is empty.
- [x] `decision.stage-b-signals` replaces both constants with normalised scores capped at 0.5 in the weighted formula, and leaves them at 0.5 on `abstain`.
- [x] The Stage C band, auto-apply eligibility and the framework route read a baseline Stage A/B run with no judged input, enforced by a type boundary, and judged values are never persisted.
- [x] `estimate.class` follows the order frontmatter, judgment, regex, default, and reports `source` `judgment` only on an `act` outcome.
- [x] With `sourceKind` `gh-issue`, `reversible` and a declared duplicate are not acted on.
- [x] Each definition provides `agrees`, and `cli-judgment eval estimate.class` runs against a JSONL corpus with a fake provider.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added the five Group A judgments (decision reversibility, pillars, duplicate, Stage B signals and estimation class) behind an injectable runner that is off by default. They can only keep or add scrutiny relative to the existing heuristics: the three literal forms the task originally asked for would have let a judgment reduce review, so they were refused as relaxations and built in a conservative form that rfc-planner confirmed.

## Changes
- `reference/src/judgment/catalog/`: the five definitions (`decision-reversibility`, `decision-pillars`, `decision-duplicate`, `decision-stage-b-signals`, `estimate-class`) and a shared helper, registered through the catalog.
- `pipeline-cli/src/judgment/runner.ts`: the injectable runner (disabled when no provider is configured or `AI_SDLC_JUDGMENT=off`).
- `pipeline-cli/src/decisions/judged.ts`, `baseline-brand.ts`, `stage-a.ts`, `stage-b.ts`, `stage-c.ts`, `cli/decisions.ts`: judged input wiring and the baseline gating boundary.
- `pipeline-cli/src/estimation/judged-class.ts` and `class-assignment.ts`: class order frontmatter, judgment (act only), regex, default; `source` gains `judgment`.
- A fixture corpus and test for `cli-judgment eval estimate.class` with a fake provider.
- `pipeline-cli/src/cli/judgment.test.ts`: the test helper now declares `fallback: 'pending'`; without it 13 tests failed on main under the registration rule.

## Design decisions
- **Class and direction.** All five declare `egressClass` `work-item-text`, `riskClass` `seam`, `direction` `bidirectional`, `fallback` `pending`, `reducingOutcomes` `[]` and `reducesReview` `false`, as the task mandates. Pillars, Stage B signals and estimation class have no permissive outcome in the built form, so tighten-only would be equally valid; bidirectional was kept as the task requires.
- **Why `reducesReview: false` holds, per definition (checked against the real consumers).** Reversibility: a judged `reversible` is only recorded and the gating value stays `unknown`; a judged `one-way` only adds scrutiny; a keyword or explicit hit always survives. Pillars: union only, a judged pillar never removes a keyword pillar. Duplicate: a declared duplicate only removes the decision from the Stage A resolved set and never clears an edit-distance duplicate. Stage B signals: capped at 0.5, so only levels that lower confidence take effect. Estimation class: nothing outside estimation reads the class or bucket.
- **Baseline gating.** The Stage B composite picks the Stage C band and the framework route, and it is not monotonic in review, so any judged input could move a decision into the auto-apply band. Every gating read therefore uses a branded baseline run with no judged input; the judged composite is display only, and `score-a --store` persists the baseline Stage A.
- **Consequence: the judged Stage B signals, pillars and reversibility have no gating effect in this change.** They inform display and scoring only. Any gating use of them is a relax-class question for the operator.
- Decision text is judged under source kind `untrusted-external` (a dispatched agent's escalation text can carry external issue content), so permissive outcomes are escalated.
- The two capability ids `decisions.stage-b-signals` and `estimation.class-assignment` were already in the capability registry and the known-ids list.

## Verification
- `pnpm build` — passed
- `pnpm test` — reference judgment suite (230) and the touched pipeline-cli decisions, estimation, judgment and CLI suites (933) passed; `tsc --noEmit` clean; the known bin-invocation, verify-runtime and TUI failures reproduce on clean main; the full root suite was not run
- `pnpm lint`, prettier on touched files, `pnpm dark-code:check`, `node scripts/check-rfc-docs.mjs` — passed
- 3 parallel reviews approved after four rounds (Claude-native reviewers, security on Opus); reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-635.1: operator decision on whether to add relax-class definitions for reversible promotion, pillar replacement and Stage B scores above 0.5.
- declined: tests for the display-only judged-leg strip, a behavioural source-kind test and wider `--store` cases, because they only cover display-only paths that no gate reads.
- declined: a thresholds section in the judgment documentation, because the threshold keys are read in one place and are a documentation tidy-up with no behaviour change.
<!-- SECTION:FINAL_SUMMARY:END -->
