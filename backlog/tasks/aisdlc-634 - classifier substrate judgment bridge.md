---
id: AISDLC-634
title: >-
  RFC-0049 Group A: classifier-substrate bridge and the five substrate judgment definitions
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-4
  - classifier
  - capture
  - decisions
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/classifier/substrate/types.ts
  - pipeline-cli/src/classifier/substrate/classify.ts
  - pipeline-cli/src/classifier/substrate/task-prompts.ts
  - pipeline-cli/src/capture/invoker-loader.ts
  - pipeline-cli/src/decisions/stage-c.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The classifier substrate serves five task types and has no production invoker, so
every call returns the `pending` sentinel at confidence 0. This task gives it a
backend through the judgment layer without changing its fail-open behaviour.
RFC-0049 section 5, Group A.

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
1. **Five definitions** in the judgment catalog, all `egressClass` `work-item-text`,
   `riskClass` `seam`, `direction` `bidirectional`. Option sets come from the allowed
   enums already defined in `pipeline-cli/src/classifier/substrate/task-prompts.ts`;
   do not restate them by hand.
   - `capture.triage`: a Choice over the substrate's triage enum, excluding the pending
     sentinel value, which is never offered as an option.
   - `capture.severity`: a Choice over the severity enum.
   - `capture.pr-comment`: a Noul, "is this review comment reporting a problem or
     follow-up that should be tracked".
   - `dor.answer-segment`: a Choice over the three segment classes.
   - `decision.recommendation`: a Choice over the caller's `context.optionIds`, with
     each option's description as the criteria text, plus an explicit
     none-of-these option.
   Each definition writes option descriptions that separate the options from each
   other (what it covers, what belongs elsewhere), puts only the fields the question
   needs into the state, and names its permissive outcomes: the won't-fix triage class,
   the lowest severity, a not-a-capture answer, and any decision recommendation. With
   `permissiveAllowed` false those outcomes become `escalate` to the operator.
   `compose` acts when confidence (or, for the Noul, distance from 0.5) clears the
   configured threshold and escalates otherwise.
2. **Bridge in `classify()`** (`pipeline-cli/src/classifier/substrate/classify.ts`):
   when no invoker is supplied and the matching judgment returns `act`, use its
   decision as `classification`, the answer's confidence as `confidence`, and
   `judgment:<id>@<version>` as `reasoning`; the corpus entry records
   `<provider>@<modelVersion>` as `model`. On `abstain` or `escalate` the existing
   path runs unchanged and yields the `pending` sentinel exactly as today.
3. **Precedence:** when `AI_SDLC_CLASSIFIER_INVOKER_MODULE` resolves to an invoker, it
   wins and the judgment is not consulted (RFC-0049 Migration Path).
4. **Thresholds:** the substrate's existing 0.7 default was chosen for a generative
   model's self-reported confidence and is not reused. Judgment thresholds come only
   from the judgment config; with none configured the runtime keeps the judgment in
   `shadow`.
5. **Capability ids:** each definition sets `capabilityId` to the matching id from
   the RFC-0049 section 9.1 table (`classifier.capture-triage`,
   `classifier.capture-severity`, `classifier.pr-comment-is-capture`,
   `classifier.dor-answer-is-new-concern`, `decisions.stage-c-recommendation`).
6. **`agrees`** on each definition compares the decision with a corpus label, so
   `cli-judgment eval` can run against `.ai-sdlc/classifier-corpus/<task-type>.yaml`
   entries that carry an operator override. Provide a small converter from that corpus
   format to the `eval` JSONL format.

## Acceptance Criteria
- [ ] The five definitions are registered, build their option sets from the substrate's existing enums, and never offer the pending sentinel as an option.
- [ ] With the layer disabled, `classify()` output for every task type is byte-identical to its output before this change (regression test on the existing fixtures).
- [ ] With a judgment in `enforce` returning `act`, `classify()` returns that classification with `metBehindThreshold` true and a corpus entry whose `model` names the provider and version.
- [ ] With a judgment in `shadow`, `classify()` returns the `pending` sentinel and one judgment-log record is written with the incumbent recorded.
- [ ] With `sourceKind` `gh-issue`, a permissive outcome (won't-fix, lowest severity, not-a-capture, any recommendation) is returned as `pending`, not acted on.
- [ ] A configured `AI_SDLC_CLASSIFIER_INVOKER_MODULE` invoker is used and the fake judgment provider receives no request.
- [ ] `decision.recommendation` handles a decision with two options and with eight, and returns `escalate` when the none-of-these option wins.
- [ ] The corpus converter turns a classifier-corpus YAML file with operator overrides into `eval` JSONL, and `cli-judgment eval capture.triage` runs on it with a fake provider.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
