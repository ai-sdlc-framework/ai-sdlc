---
id: AISDLC-534.1
title: >-
  main is RED: DOCS_ONLY_PATTERN out of lockstep with is-docs-only-changeset.mjs after AISDLC-534; make one source of truth
status: To Do
assignee: []
created_date: '2026-10-11'
labels:
  - ci
  - main-health
  - bug
dependencies: []
references:
  - scripts/is-docs-only-changeset.mjs
  - pipeline-cli/attestation-core/review-scope-core.mjs
  - pipeline-cli/src/attestation/review-scope.ts
  - pipeline-cli/src/attestation/review-scope.test.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
main-health has failed on every main commit since 9eca1d33 (PR #1373, AISDLC-534). The `pipeline-cli` test `review-scope.test.ts > classifyReviewScope > DOCS_ONLY_PATTERN stays in lockstep with scripts/is-docs-only-changeset.mjs` fails because the script gained `.github/dependabot.yml` and `.github/[^/]+\.md` while the copy of `DOCS_ONLY_PATTERN` did not. Per-PR CI did not catch it: affected-package filtering does not run pipeline-cli tests for a `scripts/`-only change, and the planner's review of #1373 missed the lockstep. Every open PR now shows Build & Test red on this one test once rebased, so this blocks the whole drain.

**Where the copy actually lives.** `pipeline-cli/src/attestation/review-scope.ts` does not itself define `DOCS_ONLY_PATTERN`; the test imports it from `pipeline-cli/attestation-core/review-scope-core.mjs` (the verifier-shared core). That file's comment says the script "is not shipped with the published package, so the verifier cannot import it", which is why a copy plus a lockstep test was chosen.

**Exact current patterns.**

`scripts/is-docs-only-changeset.mjs`:

```
/^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|\.github\/dependabot\.yml$|\.github\/[^/]+\.md$|[^/]+\.md$)/
```

`pipeline-cli/attestation-core/review-scope-core.mjs`:

```
/^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|[^/]+\.md$)/
```

The difference is exactly `\.github\/dependabot\.yml$|\.github\/[^/]+\.md$`. The failing assertion is `expect(DOCS_ONLY_PATTERN.source).toBe(mod.DOCS_ONLY_PATTERN.source)` at `review-scope.test.ts` line 151. Introduced by AISDLC-534.

**Five-step review (requirements first).** (1) Requirement questioned: "the docs-only classification exists in two places and a test keeps them equal" (AISDLC-206 / AISDLC-342 era). The duplication is the defect; a lockstep test is a smoke alarm for a design that should not exist. (2) Delete: ONE definition, and the lockstep test is deleted, not fixed. (3) Simplify: the script is plain ESM consumed by CI and the hook; either have the core import it, or move the pattern into a tiny shared module both import. Because the core ships in the published package and the script does not, the shared module must live inside the shipped tree (for example `pipeline-cli/attestation-core/docs-only-pattern.mjs`) and the script imports from it; try that first. If a direct import cannot work in the pipeline-cli build, the fallback is a generated constant with a build-time check. (4) Accelerate: land part A alone immediately if B is not quick, since main is red. (5) Automate: the single definition makes drift impossible, so no test is needed.

**Fix, two parts.**
- Part A (hotfix): sync the copy by adding `\.github\/dependabot\.yml$|\.github\/[^/]+\.md$` before `[^/]+\.md$` in `review-scope-core.mjs`. If B is not quick, land A alone immediately and name a follow-up sub-id (AISDLC-534.2) for B.
- Part B: single source of truth as in step 3 above, and delete the lockstep test.

**Velocity impact.** Positive: unblocks every open PR and removes a recurring drift class.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `pnpm --filter @ai-sdlc/pipeline-cli test` passes (review-scope tests green).
- [ ] #2 main-health-monitor is green on the merge commit.
- [ ] #3 The docs-only classification lives in exactly one place (grep for the regex body finds one definition), OR, if part B is deferred, the PR body says why and a follow-up sub-id is named.
- [ ] #4 `scripts/is-docs-only-changeset.test.mjs` still passes.
- [ ] #5 The task body names the five steps (done above; keep in the PR body).
<!-- AC:END -->

## Verification

`pnpm build && pnpm --filter @ai-sdlc/pipeline-cli test && node --test scripts/is-docs-only-changeset.test.mjs`, then `pnpm lint && pnpm format:check`.
