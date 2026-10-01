---
id: AISDLC-677
title: >-
  RFC-0052: staged pipeline as shadow beside the gating set, per-case comparison record, flagged cases, cli-usage replay --set
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - evaluation
  - model-routing
dependencies:
  - AISDLC-676
  - AISDLC-655
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - pipeline-cli/src/cli/reviews.ts
  - pipeline-cli/src/attestation/reviews-analysis.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The comparison the operator asked for: on every trusted PR the existing set gates and
the staged pipeline also runs; both results are recorded and compared per case, with
the security comparison reported on its own. RFC-0052 section 6 and the OQ-1 and OQ-2
resolutions.

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
1. **Shadow run**: with `staged.shadow: true` in the base-ref review config, Step 7
   runs the configured gating set as today and then the staged pipeline; the staged
   verdict is written to the reviews ledger as role `staged` with `gating: false` and
   never reaches Step 8.
2. **Comparison record** per PR and iteration, written under the artifacts directory
   and summarised by `cli-reviews compare`: findings only the staged set raised,
   findings only a standalone reviewer raised, agreements, each with severity; the
   security comparison as its own section (staged findings in the security remit
   against the Opus `security-reviewer`'s findings on the same PR); units per review
   per set from the usage ledger where present.
3. **Flagged cases**: a PR where either side raised a critical or major finding the
   other did not is flagged, listed first in `compare`, and emitted as a
   `ReviewComparisonFlagged` event for the operator surface.
4. **Bar check**: `cli-reviews compare --bar` reports whether 50 compared PRs exist and
   the staged set's act-band precision against the gating set's blocking outcomes,
   in the form the RFC-0050 promotion record expects; and the same figures for the
   security subset.
5. **Replay**: `cli-usage replay --set staged` runs the staged pipeline over the
   reviews-ledger corpus (AISDLC-655) and reports recall, false-block rate and units
   beside `three` and `code-test-merged` on the same items, with the security subset
   separate; replay never writes to the ledger, leaves or attestations.

## Acceptance Criteria
- [ ] With shadow enabled, Step 8 receives only the gating set's verdicts and the ledger gains a `staged` row with `gating: false` for the same commit.
- [ ] `cli-reviews compare` on a fixture ledger lists staged-only, standalone-only and agreed findings with severities, and a separate security section.
- [ ] A fixture PR where only one side raised a major finding is flagged, listed first, and emits `ReviewComparisonFlagged`.
- [ ] `--bar` reports the compared-PR count and act-band precision for the overall and security subsets, and states met or not met against 50 and 0.95.
- [ ] `cli-usage replay --set staged` produces the per-set comparison on a fixture corpus with a mock spawner and leaves the ledger, leaves and attestation directory byte-identical.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
