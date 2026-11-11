---
id: AISDLC-1262
title: '`trusted-push` re-adds only plain global `credential.helper`; a URL-scoped helper from `gh auth setup-git` (`credential.<url>.helper` with the GitHub HTTPS origin as `<url>`) is dropped and the push fails with "could not read Username"'
status: To Do
assignee: []
created_date: '2026-11-11'
labels:
  - pipeline-cli
  - runtime
  - adopter
  - bug
dependencies: []
references:
  - pipeline-cli/src/runtime/trusted-push.ts
  - pipeline-cli/src/runtime/trusted-push.test.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
priority: high
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2622). Verified in trusted-push.ts: the reset uses `-c credential.helper=` and re-adds only `git config --global --get-all credential.helper`; `credential.<url>.helper` keys are never read.'
---

## Description

**Gap (issue #2622, observation 3).** `trusted-push.ts` resets the multi-valued `credential.helper` with `-c credential.helper=` so a worktree-planted helper cannot run with the operator's credentials, then re-adds the operator's global `credential.helper` values. `gh auth setup-git` writes a URL-scoped `credential.<url>.helper` key for the GitHub HTTPS origin, which the reset does not touch and the re-add does not restore. Whether it survives depends on git's config merge order; the adopter's push failed with "could not read Username" for the GitHub HTTPS remote.

**Shape.** Read every global `credential.*.helper` key (`git config --global --get-regexp '^credential\..*\.helper$'`) and re-add each under its own key, keeping the reset of the worktree-level value. The threat model is unchanged: only global (operator) values are re-added; local and worktree config are still ignored.

## Fix

**Five-step review.**
1. Requirement questioned: the reset exists so a planted helper never runs; stands.
2. Deleted: nothing.
3. Simplified: one regexp read instead of one key.
4. Accelerated: pushes work for every `gh auth setup-git` user with no manual config.
5. Automated: test with a fake global config containing both plain and URL-scoped helpers.

## Acceptance Criteria

- [ ] AC-1: `trustedPushArgs` (or its caller) re-adds every global `credential.<url>.helper` under the same key, in addition to plain `credential.helper`; unit test with a fake `git config --global --get-regexp` output containing both.
- [ ] AC-2: a URL-scoped helper set in the worktree or local config is still not re-added; test.
- [ ] AC-3: when no global helper exists the argument list is unchanged from today; test.
- [ ] AC-4: the module header comment documents the URL-scoped case.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
