---
id: AISDLC-663.5
title: >-
  Harden cli-merge-if-eligible (PR-derived trust, head pin, verified main policy, API-merge hook) before the allowMerge grant
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - governance
  - security
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - spec/schemas/agent-role.schema.json
  - docs/api-reference/governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A security review of the planned operator change that adds `governance.allowMerge: onGreenClean`
found that `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog` does not
enforce the trust boundary that grant relies on:

1. Trust came from the caller-supplied `--source-kind` alone, so any PR (a fork PR, another
   author, a non-main base, no backlog task) could be merged by passing `backlog`.
2. The head commit was not pinned: the checks were read, then the merge ran against whatever the
   head had become.
3. The policy was read from `--repo-root` or the current directory, which in a worktree is a copy
   the governed agent can edit.
4. Merging through `gh api .../pulls/<n>/merge` (or `curl`/`wget`) bypassed the hook, which only
   matched the raw merge command.

This task closes those four gaps before the grant lands. It does not touch `CLAUDE.md` or anything
under `.ai-sdlc/`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] The CLI refuses unless, from the PR data it fetches itself, the PR is not from a fork, its base is `main`, its author is on a non-empty allow-list read from the verified main checkout, and a backlog task matching the id derived from the head branch/title exists on `origin/main` or in the PR's own diff. `--source-kind gh-issue` stays refused.
- [x] Head commit, merge state and provenance come from one `gh pr view` call; the head is re-read before merging and a moved head refuses; the merge is issued with `--match-head-commit <sha>` and a GitHub refusal is reported with a non-zero exit.
- [x] The policy and allow-list are read only from the verified main checkout; the working directory must belong to the same checkout as the CLI; a missing or unverifiable main root refuses; `--repo-root` is honoured only under `AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS=1`; a worktree copy saying `onGreenClean` is ignored.
- [x] The hook denies `gh api` calls to `.../pulls/<n>/merge` (any method, leading slash or not, flags in any order), `curl`/`wget` to the REST merge endpoint and the GraphQL `mergePullRequest` mutation, under every `allowMerge` value, while arming auto-merge and the sanctioned helper stay allowed.
- [x] `spec.governance.mergeAuthors` exists in the schema (and the Go SDK copy and generated schemas), resolves to an empty list when absent or malformed, and existing policies without it still resolve.
- [x] Tests cover each rule (fork, wrong author, empty allow-list, no task, non-main base, moved head, worktree policy copy ignored, several API-merge spellings, helper allowed, arming allowed) and the key rules were mutation-checked in a scratch copy.
- [x] `docs/api-reference/governance.md` describes the hardened conditions and the test-only environment variable; nothing is claimed that the code does not do.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`cli-merge-if-eligible` now derives trust from GitHub data and the verified main checkout instead of the `--source-kind` flag alone, pins the merge to the head commit the checks were evaluated against, and the hook closes the API-merge side door. The `allowMerge: onGreenClean` grant can now be applied without leaving those holes open.

## Changes
- `pipeline-cli/src/governance/merge-if-eligible.ts` (modified): one `gh pr view` snapshot (`fetchPrSnapshot`), `evaluatePrTrust` (fork, base `main`, `mergeAuthors`, task id from branch/title plus a task file on `origin/main` or in the PR diff), head re-read and `--match-head-commit` pin, `resolveTrustedMainRoot` (verified main checkout, cwd must match, test-only override), `resolveRepoMergeAuthors`, `loadTrustedPolicyModule`.
- `pipeline-cli/src/cli/merge-if-eligible.ts` (modified): verified root instead of `--repo-root`/cwd, slug derived from the verified checkout (a conflicting `--repo` is refused), `--repo-root` documented as test-only.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (modified): `enforceApiMergeGovernance` denies `gh api`/`curl`/`wget`/interpreter calls to `.../pulls/<n>/merge` and the `mergePullRequest` mutation under every policy.
- `ai-sdlc-plugin/hooks/lib/governance-resolver.js` (modified): `resolveMergeAuthors` / `resolveMergeAuthorsFromYaml`; `mergeAuthors` parsed as a list key.
- `spec/schemas/agent-role.schema.json`, `sdk-go/core/schemas/agent-role.schema.json`, `reference/src/core/generated-schemas.ts` (modified): optional `governance.mergeAuthors`.
- Tests in `pipeline-cli/src/governance/merge-if-eligible.test.ts`, `pipeline-cli/src/cli/merge-if-eligible.test.ts`, `ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs`, `ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs`, `reference/src/core/validation.test.ts`.
- `docs/api-reference/governance.md`, `ai-sdlc-plugin/commands/execute.md` (modified): the hardened conditions and the new hook rule.

## Design decisions
- **Allow-list in the policy schema**: `mergeAuthors` follows the existing `protectedBranches` pattern (optional list, hand-rolled resolver, JSON Schema pattern without lookahead so the Go copy stays valid). Absent or empty trusts nobody, so merge stays refused until the operator sets it; existing policies still resolve.
- **Task file tension**: a matching task file counts when it exists on `origin/main` (`git ls-tree`, no fetch, so the refusal message says to run `git fetch origin main`) OR is added by the PR's own diff, because the repo creates and completes a task in one PR. A file the PR deletes does not count.
- **Atomic read**: head, merge state, fork flag, author, base, title and files come from one `gh pr view` call. The required-checks fetch cannot take a commit, so the head is re-read after it and the merge carries `--match-head-commit`, which GitHub enforces atomically.
- **Trust anchor**: the main checkout of the repo containing the running CLI, required to equal the invocation's cwd checkout, so `cd` into an attacker-controlled repo cannot supply a policy.
- **Hook scope**: text-level, only fires with a network/interpreter tool word present, so `grep`/`cat` on text that mentions the path stays allowed. It also covers the GraphQL `mergePullRequest` mutation, the same bypass class.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check`, `pnpm dark-code:check` clean.
- Vitest (governance + CLI) 103 passing, about 97% line coverage on the two modules; hook tests (`node --test`) and the full reference suite passing.
- Mutation check in a scratch copy: 10 TypeScript and 5 hook mutations, all killed.

## Follow-up
- declined: protect the CLI and plugin code in the agent's own checkout from edits (blockedPaths); a worktree-rooted agent can still modify the code that decides, which is the same pre-existing residual as the lease guard, and server-side branch protection is the real backstop
- declined: block the branch-merge API (`POST /repos/<o>/<r>/merges`) in the hook; it is a different endpoint than a PR merge and out of this task's scope
- declined: reconcile the CLAUDE.md "Never merge PRs" wording; that edit needs direct operator approval and is not made here
<!-- SECTION:FINAL_SUMMARY:END -->
