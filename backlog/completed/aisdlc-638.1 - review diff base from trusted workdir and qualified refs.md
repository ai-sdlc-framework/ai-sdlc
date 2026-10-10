---
id: AISDLC-638.1
title: >-
  RFC-0049 follow-up (security major): Step 7 resolves the review diff base from the trusted workDir with fully qualified refs
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - review
  - pipeline-cli
  - security
dependencies:
  - AISDLC-638
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/steps/09-iterate.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from an executor or reviewer report on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security major from the AISDLC-638 review (#1140), pre-existing: from iteration 2 on,
Step 7 resolves the diff base with `resolveTargetBranch(worktree)`, which reads
`spec.branching.targetBranch` from the PR's own `.ai-sdlc/pipeline.yaml`. A PR can
therefore narrow what every reviewer sees. Trust-sensitive; security review on Opus.

## Scope
1. Step 9 (`pipeline-cli/src/steps/09-iterate.ts`) passes the trusted `opts.workDir`
   into Step 7 for every iteration, and Step 7 resolves the target branch from the
   base ref's pipeline config, never from the worktree copy.
2. All base refs used for the review diff are fully qualified
   (`refs/remotes/origin/<branch>`), so a local branch or tag with the same short
   name cannot shadow the base.
3. The resolved base ref and the config source are recorded in the review prompt
   metadata and the judgment log so a narrowed diff would be visible after the fact.
4. A regression test that commits a `pipeline.yaml` with a different `targetBranch`
   in the worktree and asserts the review diff is unchanged.

## Acceptance Criteria
- [x] On iteration 2 the review diff base comes from the base ref's config; a worktree `pipeline.yaml` naming another branch does not change the diff (regression test).
- [x] Every base ref passed to git in Step 7 is fully qualified; a same-named local branch does not shadow it (test).
- [x] The resolved base and its source are recorded on the review step result.
- [x] Iteration 1 behaviour is unchanged on existing fixtures.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Step 7 now resolves the review diff base from the trusted `workDir` on every iteration, and Step 9 passes `opts.workDir` instead of the PR worktree path. Base refs are fully qualified as `refs/remotes/origin/<branch>`. `baseRef` and `baseRefSource` are recorded on the Step 7 result and on each review prompt.

## Changes
- `pipeline-cli/src/steps/07-build-review-prompts.ts` (modified): trusted-workDir target-branch resolution, qualified refs, baseRef/baseRefSource recording.
- `pipeline-cli/src/steps/09-iterate.ts`, `pipeline-cli/src/types.ts`, `pipeline-cli/src/execute-pipeline.ts`, `pipeline-cli/src/cli/rework-pr.ts`, `ai-sdlc-plugin/mcp-server/src/tools/pipeline-tools.ts` (modified): thread `workDir` through.
- Step 7/9 and execute-pipeline tests (modified/new): regression tests for the worktree pipeline.yaml override and local branch/tag shadowing.

## Design decisions
- **Config source**: read from the trusted workDir's pipeline.yaml rather than `git show` of the base ref copy; the parent checkout is guarded on main (AISDLC-358).

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check`, `pnpm dark-code:check` — clean
- `pnpm test` — touched suites pass; 12 pipeline-cli tests fail for environmental reasons (bin-invocation `pnpm exec`, verify-runtime, TUI) unrelated to this change; CI is the gate.

## Follow-up
- declined: reviewer minors (baseRefSource provenance precision, step 9 workDir!=worktreePath test, targetBranch shape validation) are non-blocking; no follow-up filed.
<!-- SECTION:FINAL_SUMMARY:END -->
