---
id: AISDLC-676
title: >-
  RFC-0052: reviewerSet staged in resolution, Step 7 and Step 8; transcript leaves with stage; reviews-ledger role
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - pipeline-cli
  - plugin
  - attestation
  - security
dependencies:
  - AISDLC-674
  - AISDLC-675
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - pipeline-cli/src/steps/reviewer-set.ts
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/attestation/merkle.ts
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/bin/cli-attestation.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Makes `staged` a selectable reviewer set and attests each stage. Touches the review
step of `execute.md` and the attestation leaf shape; trust-sensitive. RFC-0052
sections 5 and 6, and the OQ-3 resolution.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0052-staged-review-pipeline.md`. Its Open Questions are
  resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages, `node --test`
  for plugin scripts, 80% line coverage on new code.
- Tests never call a model or the network; spawners and fetch are injected.
- The developer agent never writes under `.ai-sdlc/`; repo config changes are operator
  steps with the YAML carried in the PR body.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Reviewer set**: `ReviewerSetMode` gains `staged`; `resolveReviewerSetMode` reads
   it from the base-ref `review-config.yaml` or `AI_SDLC_REVIEWER_SET`, exactly as the
   merged set is read; in v1 `staged` as the gating set is accepted only for
   `sourceKind` `backlog` and falls back to `three` otherwise with a logged reason.
2. **Step 7**: for the `staged` set, run risk map (672), plan (674), execute (675) and
   synthesize (674) in order, then hand the single verdict to Step 8; `execute.md`
   gains the corresponding branch beside the existing fan-out, passing the resolved
   models from the routing cells on each agent call.
3. **Step 8**: aggregation treats a set of one verdict correctly (as it treats the
   merged set of two).
4. **Leaves**: `cli-attestation emit-leaf` accepts an additive `--stage`
   (`plan` | `execute` | `synthesize`); one leaf per planner, per probe and per
   synthesizer transcript; executor leaves carry zero findings and
   `verdictApproved: false`; only the synthesizer leaf carries the verdict. The
   verifier accepts leaves with or without `stage` (field is optional and omitted
   when unset, per the base-verifier boundary rule).
5. **Ledger**: `ReviewLedgerRole` gains `staged`; `reviews-analysis` treats the
   synthesizer leaf as the verdict and counts per role as before.
6. **Independence**: tiers computed per leaf; the set's tier is the weakest leaf.

## Acceptance Criteria
- [ ] `reviewerSet: staged` on the base ref selects the staged pipeline; a working-tree copy is ignored; `gh-issue` work falls back to `three` with a logged reason.
- [ ] Step 7 for the staged set produces one verdict and Step 8 aggregates it with the same blocking rules as today (fixture with a critical finding blocks; without, approves).
- [ ] One leaf is emitted per planner, per probe and per synthesizer transcript with the matching `stage`, executor leaves carry no findings, and an envelope with these leaves verifies.
- [ ] Leaves without `stage` continue to verify unchanged, and a leaf never writes `stage` as null or empty.
- [ ] The set's independence tier equals its weakest leaf's tier (fixture with one unattested probe).
- [ ] `cli-reviews analyze` on a ledger containing `staged` rows reports them under that role without changing other roles' counts.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
