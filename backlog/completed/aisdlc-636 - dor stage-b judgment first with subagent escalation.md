---
id: AISDLC-636
title: >-
  RFC-0049 Group B: dor.stage-b judgment-first Definition-of-Ready Stage B with refinement-reviewer escalation
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-5
  - dor
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/dor/stage-b.ts
  - pipeline-cli/src/dor/composite.ts
  - spec/dor-corpus/README.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DoR Stage B is designed to spend a `refinement-reviewer` subagent run to answer one
yes/no question per gate, but no production caller passes a spawner, so Stage B never
runs: in 158 logged evaluations gates 4 (scope) and 6 (done-state) are `skip` every
time. This task makes those gates run, with one judgment request covering all
Stage-B-owned gates. RFC-0049 section 5, Group B.

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
1. **`dor.stage-b` definition:** `egressClass` `work-item-text`, `riskClass` `tighten`,
   `direction` `tighten-only`, `reducesReview` `false` (declared explicitly),
   `capabilityId` `dor.stage-b`, with `agrees`. One Noul per gate that Stage B owns or
   re-checks, derived from the existing `STAGE_B_GATE_QUESTIONS` in
   `pipeline-cli/src/dor/stage-b.ts`, each with explicit true and false criteria and
   written as a literal condition. ONE provider request covers all Stage-B-owned gates.
   State holds the issue title, body and the resolved one-hop references Stage B already
   receives, nothing else (`buildState` selects only these; the text is data, not
   instructions).
2. **Thresholds** `pass` and `fail` per gate from the judgment config. A gate is
   `pass` at or above `pass`, `fail` at or below `fail`, otherwise `unsure`.
3. **Compose** returns a per-gate result list in every non-abstain outcome: at least one
   gate `fail` gives `act` with the per-gate results; otherwise `escalate` to `llm` with
   the per-gate results as `partial`. Compose never reads `permissiveAllowed`: whether a
   judged pass may be used is decided in one place, `applyJudgedGates`.
4. **Wiring** in `pipeline-cli/src/dor/composite.ts`, after Stage A, through the single
   function `applyJudgedGates`:
   - A judged `fail` sets that gate to `fail` (needs-clarification) with a templated
     clarification question built from that gate's entry in `STAGE_B_GATE_QUESTIONS`, on
     any `sourceKind` (tightening).
   - A judged `pass` only fills a gate that would otherwise be `skip`, only when NO
     spawner is supplied, and only for `sourceKind` `backlog`. A judged pass never
     overrides a Stage A fail of ANY confidence or severity, and a Stage A pass stays a
     pass. The judged result never goes through `chooseWinner`.
   - A supplied spawner is ALWAYS run, exactly as today (it writes the clarification
     question). The judgment can only add a failed gate with a spawner supplied, never
     remove a failure.
   - Unsure gates with no spawner stay `skip`; on `abstain` (layer off, shadow, error)
     the existing path runs unchanged; a deterministic Stage A block is never overridden.
5. **Capability id:** the definition sets `capabilityId` `dor.stage-b`
   (RFC-0049 section 9.1).
6. **Calibration log:** records whether Stage B verdicts came from the judgment, the
   subagent, both or neither (`stageBSource`).
7. **`agrees`** compares the judgment's per-gate result with the expected verdicts in
   the `spec/dor-corpus/` fixtures; the converter from that corpus to `eval` JSONL is
   `cli-judgment dor-corpus`, and its output feeds both `cli-judgment eval dor.stage-b`
   and `cli-judgment eval dor.stage-b-pass`.
8. **Second definition `dor.stage-b-pass`** (the relax half): `egressClass`
   `work-item-text`, `riskClass` `relax`, `direction` `bidirectional`, `reducesReview`
   `true`, `reducingOutcomes` `['all-gates-pass']`, `capabilityId` `dor.stage-b`, with
   `agrees`. Its single act outcome is named `all-gates-pass`; every other result is an
   escalate (or abstain on unusable thresholds). It acts only when `permissiveAllowed` is
   true (trusted `backlog` work), Stage A failed no gate at any confidence, and every
   Stage-B-owned or re-checked gate is at or above the `pass` threshold. In `composite.ts`,
   an `all-gates-pass` act (enforce with a satisfying corpus-path relax promotion; shadow
   and disabled have no effect) skips the subagent even when a spawner is supplied and the
   skipped gates become `pass`. The wiring repeats the guards (backlog only, no Stage A
   failure, no failing gate from `dor.stage-b`). It ships in shadow; promotion is by the
   corpus path only (50 items, 0.95 act-band precision, `spec/dor-corpus` as the
   evaluation source); the existing relax bar logic is unchanged.

## Design note
RFC-0049's premise that a wrong Stage B pass "costs a wasted developer run, not reduced
review" was false against `composite.ts` as originally specified, for two reasons:
(i) `chooseWinner` let a Stage B pass override a Stage A medium- or low-confidence
blocking fail (only a high-confidence block was protected), and (ii) skipping a supplied
spawner skips a reviewer that can fail gates 4 and 6. Because Stage B passes can reduce
review, the work is split into two definitions (see the RFC-0049 amendment, PR #1142):
`dor.stage-b` is `tighten-only` / `tighten` and removes both problems (a judged pass only
fills a `skip` gate with no spawner and never touches a Stage A fail of any confidence; a
supplied spawner always runs), and `dor.stage-b-pass` carries the review-reducing path
under its own declarations (`relax`, `bidirectional`, `reducesReview` true,
`reducingOutcomes` `['all-gates-pass']`), held to the relax bar and shipped in shadow.
Each `compose` has a comment stating exactly which outcomes it can produce and why that
matches its declarations. With both definitions configured, each makes its own provider
request over the same questions (the answer cache dedupes them when enabled).

## Acceptance Criteria
- [ ] With the layer disabled or in `shadow`, `evaluateIssueE2E` returns the same result as before for the existing fixtures, with and without a spawner.
- [ ] With a spawner supplied the spawner is called exactly as today regardless of the judgment, and the judgment's fail result can only add a failed gate / clarification, never remove a failure.
- [ ] In `enforce` with no spawner and one gate below `fail`, that gate's verdict is `fail` with a templated clarification question, the overall verdict is `needs-clarification`, and this holds for `sourceKind` `gh-issue` as well.
- [ ] In `enforce` with no spawner and a gate in the unsure band, that gate stays `skip` and the overall verdict matches Stage A alone.
- [ ] A judged pass only fills a gate that would otherwise be `skip`, only with no spawner and only for `backlog`; with `sourceKind` `gh-issue` the judgment never produces a pass by itself.
- [ ] A judged pass never overrides a Stage A fail of any confidence or severity, and a Stage A pass stays a pass (covered by a test across Stage A verdict permutations).
- [ ] A Stage A block at high confidence is preserved regardless of the judgment's answers.
- [ ] All Stage-B gate questions go out in a single provider request.
- [ ] The calibration log entry names the source of the Stage B verdicts.
- [ ] The corpus converter produces `eval` JSONL from `spec/dor-corpus/`, and `cli-judgment eval dor.stage-b` runs on it with a fake provider.
- [ ] `dor.stage-b-pass` registers under the relax / bidirectional / reducesReview rules (variants violating rules (c) and (d) are rejected), acts only with the name `all-gates-pass`, and only for trusted `backlog` work with no Stage A failure and every gate above `pass`.
- [ ] A matrix test over source kind, spawner, Stage A result (pass, fail at high, medium, low confidence), judgment result and mode (disabled, shadow, enforce with promotion, enforce without promotion) shows the relax path never acts outside backlog work, never relaxes a Stage A fail, and skips a supplied spawner only for `all-gates-pass`.
- [ ] `cli-judgment eval dor.stage-b-pass` runs on the corpus JSONL with a fake provider.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
