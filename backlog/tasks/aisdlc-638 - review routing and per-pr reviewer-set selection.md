---
id: AISDLC-638
title: >-
  RFC-0049 OQ-1: review.routing (tighten) and review.reviewer-set (relax, trusted work, corpus-only promotion)
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-7
  - review
  - security
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/classifier/classifier.ts
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/cli/reviews.ts
  - pipeline-cli/src/steps/07-build-review-prompts.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two judgments about who reviews a change. One may only add scrutiny. The other is the
single `relax`-class judgment in RFC-0049: it may select the merged two-reviewer set
(`correctness-reviewer` plus `security-reviewer`, shipped by AISDLC-617) for one PR
instead of three reviewers, under the floors fixed by the RFC-0049 OQ-1 resolution.
This touches review depth, so the floors below are load-bearing and each has its own
acceptance criterion.

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
1. **`review.routing`**: `egressClass` `code-diff`, `riskClass` `tighten`,
   `direction` `tighten-only`. After the existing path classifier in
   `pipeline-cli/src/classifier/classifier.ts` decides, Nouls ask whether the diff
   changes authentication, authorisation, session or secret handling; input
   validation, deserialisation, shell or file-path handling; dependency manifests or
   CI behaviour. The result is the union of the regex decision and any reviewer a Noul
   above threshold calls for. It never removes a reviewer the regex chose. The mirrored
   copy under `orchestrator/src/models/` is left untouched.
2. **`review.reviewer-set`**: `egressClass` `code-diff`, `riskClass` `relax`,
   `direction` `bidirectional`. Nouls ask for each risk signal that argues for separate
   code and test review (for example: changes concurrency, persistence or state
   handling; changes public API or schema; changes behaviour without changing tests;
   spans several packages). `compose` returns `act` with the merged set only when every
   signal is below its threshold and `permissiveAllowed` is true; otherwise `abstain`.
3. **`selectReviewerSet(...)`**, a new function beside `resolveReviewerSetMode` in
   `pipeline-cli/src/steps/reviewer-set.ts`; the resolver itself stays unchanged and
   pure. It returns the merged set from the judgment only when all hold:
   - the judgment's effective mode is `enforce` (the runtime requires a corpus
     promotion record with `n >= 50` and `actBandPrecision >= 0.95`);
   - `sourceKind` is `backlog`;
   - the path classifier raised no auth, lockfile or CI match;
   - the judgment returned `act`.
   In every other case it returns whatever `resolveReviewerSetMode` returns today. An
   explicit `code-test-merged` from env or base-branch config still applies as today.
4. **Floors:** `security-reviewer` is in every returned set. No path returns fewer
   reviewers than the merged set. A `review.routing` addition is applied after set
   selection and can add back to the merged set.
5. **Evidence:** `agrees` for `review.reviewer-set` reads a findings-ledger row (format
   in `pipeline-cli/src/cli/reviews.ts`): a merged-set decision disagrees with the label
   when the separate code reviewer or test reviewer recorded a critical or major
   first-pass finding on that PR. Provide the converter from the ledger to `eval` JSONL.
6. **Record:** the selected set, its source (`judgment` or `config`) and the inputs are
   written to the judgment log. Attestation code is not changed.

## Acceptance Criteria
- [ ] With the layer disabled or in `shadow`, the reviewers chosen for every existing classifier and reviewer-set fixture are unchanged.
- [ ] `review.routing` adds the security reviewer when a Noul clears its threshold on a diff the path regex did not flag, and never returns a set smaller than the regex decision.
- [ ] `selectReviewerSet` returns the merged set only when all four conditions hold; one test per condition shows that failing it alone returns the default resolver's result.
- [ ] With `sourceKind` `gh-issue` the merged set is never selected by the judgment, whatever the answers.
- [ ] An auth, lockfile or CI path match vetoes the merged set even when every risk Noul is near zero.
- [ ] `security-reviewer` is present in the returned set in every test case, and no case returns fewer than two reviewers.
- [ ] `review.reviewer-set` with a `path: override` promotion record stays in `shadow` (asserted through `evaluateJudgment`).
- [ ] The ledger converter marks a PR with a critical or major first-pass code or test finding as disagreeing with a merged-set decision, and `cli-judgment eval review.reviewer-set` runs on its output with a fake provider.
- [ ] The judgment-log record for a selection names the set, the source and the veto or signal that decided it.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
