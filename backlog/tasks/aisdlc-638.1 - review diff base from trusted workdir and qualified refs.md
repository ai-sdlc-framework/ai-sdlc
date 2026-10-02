---
id: AISDLC-638.1
title: >-
  RFC-0049 follow-up (security major): Step 7 resolves the review diff base from the trusted workDir with fully qualified refs
status: To Do
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
- [ ] On iteration 2 the review diff base comes from the base ref's config; a worktree `pipeline.yaml` naming another branch does not change the diff (regression test).
- [ ] Every base ref passed to git in Step 7 is fully qualified; a same-named local branch does not shadow it (test).
- [ ] The resolved base and its source are recorded on the review step result.
- [ ] Iteration 1 behaviour is unchanged on existing fixtures.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
