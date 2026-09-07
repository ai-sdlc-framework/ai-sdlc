---
id: AISDLC-606
title: >-
  Make the pipeline branch-agnostic: honor spec.branching.targetBranch in diff / rebase / attestation-base steps (not hardcoded origin/main)
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - pipeline-cli
  - orchestrator
  - gitflow
  - branching
  - adopter
  - follow-up
dependencies: []
references:
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/steps/11-late-rebase.ts
  - pipeline-cli/src/orchestrator/reconcile.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Surfaced by external issue #1037 (fixed in PR #1049) + operator review.** #1037
fixed the ONE place that broke gitflow adopters most visibly — the orchestrator's
`createBranch` now forks the issue branch from `spec.branching.targetBranch` (default
`main`) instead of always `heads/main`, which resolves the "PR into `develop` is a huge
unrelated diff" symptom for the `ai-sdlc run` flow.

**But the broader framework still hardcodes `origin/main` / `heads/main` as the
integration branch in several other pipeline steps.** For a fully `develop`-based repo
(`targetBranch: develop`) running the FULL pipeline (reviewers + late-rebase +
attestation), these compute against `main` and produce wrong diffs / rebases / bases.
This task makes the whole pipeline honor the resolved `targetBranch`.

## Known hardcoded-`main` surfaces to reconcile (audit for more)
- `pipeline-cli/src/steps/07-build-review-prompts.ts` — reviewer diff/files:
  `git diff origin/main...HEAD` and `git diff --name-only origin/main...HEAD`. A
  `develop`-based PR would feed reviewers a diff against `main` (wrong/huge).
- `pipeline-cli/src/steps/11-late-rebase.ts` — `git merge-base --is-ancestor origin/main HEAD`
  and `git rebase origin/main`. Should rebase onto the target branch.
- `pipeline-cli/src/orchestrator/reconcile.ts` — `git rebase origin/main` (reconcile path).
- `pipeline-cli/src/orchestrator/playbook/handlers/stacked-pr-base-squashed.ts` +
  `playbook/catalogue.ts` — rebase-onto-`origin/main` guidance/handlers.
- Attestation base: the patch-id / merge-base is computed against `origin/main`
  (`git merge-base origin/main HEAD`, `git diff-tree <merge-base>..HEAD`) — for a
  develop-based repo the base should be the target branch. Confirm the signer + verifier
  (`pipeline-cli/src/attestation/patch-id.ts`, `scripts/verify-attestation.mjs`) resolve
  the base consistently from `targetBranch`.

## Scope
- Introduce a single resolved "integration/base branch" value derived from
  `spec.branching.targetBranch` (default `main`), threaded to every step above so there
  is ONE source of truth (mirror how #1037 already reads it for createBranch + createPR).
- Default behavior when `targetBranch` is unset MUST stay byte-identical to today
  (`origin/main`) — the dogfood repo itself is main-based and must be unaffected.
- Audit `pipeline-cli/` + `orchestrator/` for any other `origin/main` / `heads/main`
  literal used as a diff/rebase/merge-base base (not as a display string or a
  genuinely-main-only concept like the release branch).

## Acceptance Criteria
- [ ] Reviewer diff (step 07) is computed against the resolved target branch; a
  `develop`-based repo gets `develop...HEAD`, a main-based repo is unchanged.
- [ ] Late-rebase (step 11) + reconcile rebase onto the resolved target branch.
- [ ] Attestation base (patch-id / merge-base) is computed against the resolved target
  branch on BOTH signer and verifier (no signer/verifier base drift).
- [ ] `targetBranch` unset ⇒ every step behaves exactly as today (main).
- [ ] Hermetic tests for a `develop`-based config across each reconciled step.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Follow-up to #1037 / PR #1049 (createBranch fork base) + PR #1050 (pre-push dash-safe).
Filed at operator instruction 2026-09-07. This is the "make the whole pipeline
branch-agnostic" work that the #1037 report's "huge unrelated diff" phrasing pointed at
beyond the single createBranch call. Keep signer↔verifier attestation-base resolution in
lockstep (asymmetric base = the AISDLC-421 class of verify failures).
