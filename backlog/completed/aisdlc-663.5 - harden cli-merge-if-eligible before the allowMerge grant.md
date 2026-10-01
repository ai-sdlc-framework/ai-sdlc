---
id: AISDLC-663.5
title: >-
  Harden cli-merge-if-eligible (PR-derived trust, head pin, committed main policy, API-merge hook) before the allowMerge grant
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
   head had become, and the checks were those of the PR's current head.
3. The policy was read from a flag, an environment override or the current directory, which in a
   worktree is a copy the governed agent can edit.
4. Merging through `gh api .../pulls/<n>/merge` (or `curl`/`wget`) bypassed the hook, which only
   matched the raw merge command.

This task closes those gaps before the grant lands. It does not touch `CLAUDE.md` or anything
under `.ai-sdlc/`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] The CLI refuses unless, from the PR data it fetches itself, the PR is not from a fork, its base is `main`, its author and its head commit author are on a non-empty allow-list, and a backlog task with the repo's id shape, derived from the head branch/title, exists on `origin/main` or in the PR's own diff. `--source-kind gh-issue` stays refused.
- [x] Head commit, merge state and provenance come from one `gh pr view` call; the check runs and statuses are read for that exact SHA; the head is re-read before merging and a moved head refuses; the merge is issued with `--match-head-commit <sha>` and a GitHub refusal is reported with a non-zero exit.
- [x] The policy and allow-list are read as committed on `origin/main` in the verified main checkout (uncommitted and worktree copies ignored), resolved by code inside the CLI (no env-selected plugin file); the working directory must belong to the same checkout as the CLI; a missing or unverifiable root refuses; there is no argv or environment override of the policy root or repository (tests inject one programmatically).
- [x] The hook denies `gh api` calls to `.../pulls/<n>/merge` (any method, leading slash or not, flags in any order), `curl`/`wget` to the REST merge endpoint and the GraphQL `mergePullRequest` mutation, under every `allowMerge` value; the sanctioned helper stays allowed; `--admin` is no longer an accepted arming flag.
- [x] `spec.governance.mergeAuthors` exists in the schema (and the Go SDK copy and generated schemas) with a login pattern matching the resolver, resolves to an empty list when absent or malformed, and existing policies without it still resolve.
- [x] Tests cover each rule and the key rules were mutation-checked in a scratch copy.
- [x] `docs/api-reference/governance.md` describes the hardened conditions and states the residuals plainly; nothing is claimed that the code does not do.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`cli-merge-if-eligible` now derives trust from GitHub data and the committed policy on `origin/main` instead of the `--source-kind` flag alone, evaluates checks for the exact head commit, pins the merge to it, and the hook closes the API-merge side door. The `allowMerge: onGreenClean` grant can be applied without those holes open. Agent-side auto-merge arming is deliberately unchanged and remains an open residual (below).

## Changes
- `pipeline-cli/src/governance/merge-if-eligible.ts` (rewritten core): native verified-main-root and governance resolution (no plugin file loaded), `git show origin/main` policy/task-prefix reads, one `gh pr view` snapshot, `evaluatePrTrust` (fork, base `main`, `mergeAuthors`, head commit author, task id with the repo's prefix on `origin/main` or in the PR diff), head-SHA check runs/statuses (`fetchShaChecks`), head re-read and `--match-head-commit` pin.
- `pipeline-cli/src/cli/merge-if-eligible.ts` (modified): `--repo-root`/`--repo` removed; the repository slug comes only from `gh repo view` in the verified checkout and a failure prints a clean REFUSED line; tests inject a root through the builder option.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (modified): `enforceApiMergeGovernance`, `--admin` dropped from the arming allow-list, refusal of commands naming the removed override variable.
- `ai-sdlc-plugin/hooks/lib/governance-resolver.js`, `spec/schemas/agent-role.schema.json`, `sdk-go/core/schemas/agent-role.schema.json`, `reference/src/core/generated-schemas.ts` (modified): `mergeAuthors` with an aligned login pattern.
- Tests in the four test files plus `reference/src/core/validation.test.ts`; `docs/api-reference/governance.md` and `ai-sdlc-plugin/commands/execute.md` (modified).

## Design decisions
- **No override in production**: the policy root and repository cannot be set from argv or the environment; a test-only override exists solely as a programmatic option of the exported builder.
- **Committed policy**: `git show origin/main:.ai-sdlc/agent-role.yaml` in the verified main checkout, so uncommitted edits and worktree copies are ignored; the resolver is ported into the CLI and a parity test pins it to the plugin resolver.
- **Task file tension**: a task file counts on `origin/main` OR in the PR's own diff (the repo creates and completes a task in one PR). It is a provenance hint, not a trust signal; the author allow-list is the real signal.
- **Head-bound checks**: required context names come from `gh pr checks --required`, their state from the REST check-runs/status endpoints for the exact head SHA; the head is re-read and the merge is pinned with `--match-head-commit`.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` (changed files), `pnpm dark-code:check` clean; governance and CLI vitest passing at about 99% line coverage; hook tests, reference suite and the root gate scripts passing.
- Mutation check in a scratch copy: all key-rule mutations killed.

## Follow-up
- declined: stop agents arming auto-merge (open operator decision). Until the operator chooses to deny agent-side `--auto` or route arming through the helper, an agent can arm auto-merge on any PR (fork PRs and non-allow-listed authors included), which merges on green; only GitHub-side protections mitigate it. Two candidate patches were prepared outside the PR
- declined: protect the CLI and plugin code in the agent's own checkout from edits; an agent-editable local CLI is not a trust boundary against that agent, and GitHub-side protections (strict required checks, enforce_admins, CODEOWNERS plus required review, fork-PR workflow approval) are operator-only and essential
- declined: block the branch-merge API (`POST /repos/<o>/<r>/merges`) in the hook; a different endpoint, out of this task's scope
- declined: reconcile the CLAUDE.md "Never merge PRs" wording; that edit needs direct operator approval and is not made here
<!-- SECTION:FINAL_SUMMARY:END -->
