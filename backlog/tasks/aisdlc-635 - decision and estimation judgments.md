---
id: AISDLC-635
title: >-
  RFC-0049 Group A: decision reversibility, pillars, duplicate, Stage B signals, and estimation class judgments
status: To Do
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
All five definitions: `egressClass` `work-item-text`, `riskClass` `seam`,
`direction` `bidirectional`. In every case the existing heuristic result is passed to
`evaluateJudgment` as the `incumbent` and is what the caller uses on `abstain`.

1. **`decision.reversibility`** (`pipeline-cli/src/decisions/stage-a.ts`): Choice over
   `reversible`, `one-way`, `unknown`. Permissive outcome: `reversible`. A phrase-list
   hit for `one-way` is kept even when the judgment says `reversible`.
2. **`decision.pillars`** (same file): one Noul per pillar (engineering, product,
   design), since several can apply. The result is the set of pillars above threshold;
   an empty set falls back to the keyword result.
3. **`decision.duplicate`** (same file): the existing edit-distance pass produces a
   shortlist; one Noul per shortlisted pair, all pairs in one request, asks whether the
   two summaries describe the same decision. Permissive outcome: declaring a duplicate.
4. **`decision.stage-b-signals`** (`pipeline-cli/src/decisions/stage-b.ts`): two Score
   questions with four described levels each, one for novelty against the exemplar
   history and one for similarity to labelled exemplars, with the relevant exemplars
   from `.ai-sdlc/decision-exemplars.yaml` in the state. Each score is normalised to
   0..1 by dividing the level position by 3 and replaces the constant 0.5 in the
   existing weighted formula. On `abstain` the constants remain 0.5.
5. **`estimate.class`** (`pipeline-cli/src/estimation/class-assignment.ts`): Choice
   over `bug`, `feature`, `chore`, `uncategorized`. Resolution order becomes
   frontmatter, then judgment (`act` only), then the existing regex, then default.
   `AssignClassResult.source` gains the value `judgment`.

6. **Capability ids:** `decision.stage-b-signals` sets `capabilityId`
   `decisions.stage-b-signals` and `estimate.class` sets `estimation.class-assignment`
   (RFC-0049 section 9.1). The other three definitions set none.

## Acceptance Criteria
- [ ] With the layer disabled, the outputs of reversibility, pillar tagging, duplicate detection, Stage B scoring and class assignment are unchanged on their existing test fixtures.
- [ ] `decision.reversibility` in `enforce` overrides a keyword miss, and a keyword `one-way` hit survives a judgment answer of `reversible`.
- [ ] `decision.pillars` returns two pillars when two Nouls clear the threshold and falls back to the keyword result when none do.
- [ ] `decision.duplicate` sends all shortlisted pairs in one provider request and makes no request when the shortlist is empty.
- [ ] `decision.stage-b-signals` replaces both constants with normalised scores in the weighted formula, and leaves them at 0.5 on `abstain`.
- [ ] `estimate.class` follows the order frontmatter, judgment, regex, default, and reports `source` `judgment` only on an `act` outcome.
- [ ] With `sourceKind` `gh-issue`, `reversible` and a declared duplicate are not acted on.
- [ ] Each definition provides `agrees`, and `cli-judgment eval estimate.class` runs against a JSONL corpus with a fake provider.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
