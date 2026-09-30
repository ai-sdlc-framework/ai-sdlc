---
id: AISDLC-636
title: >-
  RFC-0049 Group B: dor.stage-b judgment-first Definition-of-Ready Stage B with refinement-reviewer escalation
status: To Do
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
   `direction` `bidirectional`. One Noul per gate that Stage B owns or re-checks,
   derived from the existing `STAGE_B_GATE_QUESTIONS` in
   `pipeline-cli/src/dor/stage-b.ts`, each with explicit true and false criteria and
   written as a literal condition. State holds the issue title, body and the resolved
   one-hop references Stage B already receives, nothing else.
2. **Thresholds** `pass` and `fail` per gate from the judgment config. A gate is
   `pass` at or above `pass`, `fail` at or below `fail`, otherwise `unsure`.
3. **Compose** returns a per-gate result list in every non-abstain outcome:
   - every gate `pass` and `permissiveAllowed` true: `act`, all gates passed at
     confidence `high`;
   - at least one gate `fail`: `act` with those gates failed (a tightening result,
     allowed on any `sourceKind`) and the remaining gates reported as `pass` only when
     `permissiveAllowed` is true, otherwise left undecided;
   - otherwise (`unsure` gates, or passes that are not permitted): `escalate` to `llm`
     with the per-gate results as `partial`.
4. **Wiring** in `pipeline-cli/src/dor/composite.ts`, after Stage A:
   - When a spawner is supplied: all-pass `act` skips the subagent; any failed or
     undecided gate runs the existing subagent path, which writes the clarification
     question.
   - When no spawner is supplied (every production path today): a failed gate becomes a
     `fail` verdict for that gate with a templated clarification question built from
     that gate's entry in `STAGE_B_GATE_QUESTIONS`, so the overall verdict is
     `needs-clarification`; a passed gate becomes `pass`; an undecided gate stays `skip`
     as today.
   - On `abstain`, the existing path runs unchanged.
   - A deterministic Stage A block is never overridden by the judgment.
5. **Capability id:** the definition sets `capabilityId` `dor.stage-b`
   (RFC-0049 section 9.1).
6. **Calibration log:** records whether Stage B verdicts came from the judgment or the
   subagent.
7. **`agrees`** compares the judgment's per-gate result with the expected verdicts in
   the `spec/dor-corpus/` fixtures; provide the converter from that corpus to `eval`
   JSONL.

## Acceptance Criteria
- [ ] With the layer disabled or in `shadow`, `evaluateIssueE2E` returns the same result as before for the existing fixtures, with and without a spawner.
- [ ] In `enforce` with every gate above the `pass` threshold on a `backlog` item, the result is ready and the mock spawner is never called.
- [ ] In `enforce` with a spawner supplied and one gate below `fail` or in the unsure band, the mock spawner is called once and its verdicts are used.
- [ ] In `enforce` with no spawner and one gate below `fail`, that gate's verdict is `fail` with a templated clarification question, the overall verdict is `needs-clarification`, and this holds for `sourceKind` `gh-issue` as well.
- [ ] In `enforce` with no spawner and a gate in the unsure band, that gate stays `skip` and the overall verdict matches Stage A alone.
- [ ] With `sourceKind` `gh-issue`, the judgment never produces a pass by itself; the existing path decides.
- [ ] A Stage A block at high confidence is preserved regardless of the judgment's answers.
- [ ] All Stage-B gate questions go out in a single provider request.
- [ ] The calibration log entry names the source of the Stage B verdicts.
- [ ] The corpus converter produces `eval` JSONL from `spec/dor-corpus/`, and `cli-judgment eval dor.stage-b` runs on it with a fake provider.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
