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
- [x] The CLI refuses unless, from the PR data it fetches itself, the PR is not from a fork, its base is `main`, its author and its head commit author are on a non-empty allow-list, and a backlog task with the repo's id shape, derived from the head branch/title, exists on `main` (per GitHub) or in the PR's own diff. `--source-kind gh-issue` stays refused.
- [x] Head commit, merge state and provenance come from one `gh pr view` call; the check runs and statuses are read for that exact SHA; the head is re-read before merging and a moved head refuses; the merge is issued with `--match-head-commit <sha>` and a GitHub refusal is reported with a non-zero exit.
- [x] The policy, `mergeAuthors`, `task_prefix` and the task-file check are read from `main` as GitHub serves it (contents and git trees APIs) for the same slug as the PR, never from a local ref, working tree or git environment variable; an API failure, non-200, empty body or truncated tree refuses; the policy is resolved by code inside the CLI (no env-selected plugin file); a verified main checkout in the invocation's working directory is kept as an extra anchor; there is no argv or environment override (tests inject one programmatically).
- [x] The hook denies every raw merge command in every flag form (arming included), `gh api` calls to `.../pulls/<n>/merge` (any method, leading slash or not, flags in any order), `curl`/`wget` to the REST merge endpoint and the GraphQL `mergePullRequest` / `enablePullRequestAutoMerge` mutations, under every `allowMerge` value; the sanctioned helper stays allowed in merge mode and in `--arm` mode.
- [x] `cli-merge-if-eligible <pr> --arm` arms auto-merge pinned to the checked head only when the same policy gate (`onGreenClean`), fork, author, head commit author, base and task checks pass and the head is unchanged on a re-read; REFUSED/ARMED output, JSON format and exit codes mirror merge mode; the plugin command/agent text that told agents to arm with a raw command now calls the helper.
- [x] `spec.governance.mergeAuthors` exists in the schema (and the Go SDK copy and generated schemas) with a login pattern matching the resolver, resolves to an empty list when absent or malformed, and existing policies without it still resolve.
- [x] Tests cover each rule and the key rules were mutation-checked in a scratch copy.
- [x] `docs/api-reference/governance.md` describes the hardened conditions and states the residuals plainly; nothing is claimed that the code does not do.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`cli-merge-if-eligible` now derives trust from GitHub data and the committed policy on `origin/main` instead of the `--source-kind` flag alone, evaluates checks for the exact head commit, pins the merge to it, and the hook closes the API-merge side door. The `allowMerge: onGreenClean` grant can be applied without those holes open. Arming auto-merge is no longer a raw agent action: the hook denies it and `--arm` routes it through the same gate.

## Changes
- `pipeline-cli/src/governance/merge-if-eligible.ts` (rewritten core): native verified-main-root (git environment cleaned, replace objects off) and governance resolution (no plugin file loaded), GitHub contents/trees API policy, task-prefix and task-file reads, paginated head-SHA check runs/statuses, the merge and arm calls kept private to the module, one `gh pr view` snapshot, `evaluatePrTrust` (fork, base `main`, `mergeAuthors`, head commit author, task id with the repo's prefix on `origin/main` or in the PR diff), head-SHA check runs/statuses (`fetchShaChecks`), head re-read and `--match-head-commit` pin.
- `pipeline-cli/src/cli/merge-if-eligible.ts` (modified): `--repo-root`/`--repo` removed; the repository slug comes only from `gh repo view` in the verified checkout and a failure prints a clean REFUSED line; tests inject a root through the builder option.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (modified): `enforceApiMergeGovernance`, every raw merge/arm form denied (the arming allow-list is gone), GraphQL arming mutation denied, refusal of commands naming the removed override variable, whole-text matching with no heredoc stripping (documentation heredocs that quote the command are denied too; accepted).
- `pipeline-cli/src/governance/merge-if-eligible.ts`, `pipeline-cli/src/cli/merge-if-eligible.ts` (modified): `--arm` mode (`armPr`, `armed` result, ARMED output).
- `ai-sdlc-plugin/commands/{execute,rebase,resolve-conflicts,orchestrator-tick}.md`, `ai-sdlc-plugin/agents/ci-conflict-resolver.md` (modified): re-arm wording now calls the helper.
- `ai-sdlc-plugin/hooks/lib/governance-resolver.js`, `spec/schemas/agent-role.schema.json`, `sdk-go/core/schemas/agent-role.schema.json`, `reference/src/core/generated-schemas.ts` (modified): `mergeAuthors` with an aligned login pattern.
- Tests in the four test files plus `reference/src/core/validation.test.ts`; `docs/api-reference/governance.md` and `ai-sdlc-plugin/commands/execute.md` (modified).

## Design decisions
- **One main commit**: the main branch is resolved once through `git/ref/heads/main` (a tag named main cannot shadow it) and the policy, config and task tree are all read at that SHA.
- **Human merge for governance changes**: merge and `--arm` refuse a PR that changes governance-sensitive paths (policy, hooks, the gate, schema, CI, ownership, agent-harness config, CLAUDE.md), judged on the full paginated file list including rename sources, and refuse when the list reaches GitHub's cap. This PR and the PR that grants `allowMerge` are therefore human-merge PRs.
- **No override in production**: the policy root and repository cannot be set from argv or the environment; a test-only override exists solely as a programmatic option of the exported builder.
- **GitHub-authoritative policy**: the policy and task checks come from GitHub for the PR's own slug, so a forged local ref, a worktree copy, an uncommitted edit or a git environment variable cannot change them, and revocation is immediate; the resolver is ported into the CLI and a parity test pins it to the plugin resolver.
- **Task file tension**: a task file counts on `origin/main` OR in the PR's own diff (the repo creates and completes a task in one PR). It is a provenance hint, not a trust signal; the author allow-list is the real signal.
- **Head-bound checks**: required context names come from `gh pr checks --required`, their state from the REST check-runs/status endpoints for the exact head SHA; the head is re-read and the merge is pinned with `--match-head-commit`.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` (changed files), `pnpm dark-code:check` clean; governance and CLI vitest passing at about 99% line coverage; hook tests, reference suite and the root gate scripts passing.
- Mutation check in a scratch copy: all key-rule mutations killed.

## Follow-up
- declined: fake `gh`, `PATH` or proxy in the agent's environment; part of the edited-or-copied-CLI residual
- declined: local CLI is not a trust boundary against the governed agent. The CLI, the plugin hooks and the checkout run from the agent's own worktree, so an agent that can edit or copy them is not bound by them. GitHub-side protections (strict required checks pinned to the Actions app, enforce_admins, CODEOWNERS plus required review on governance paths, fork-PR workflow approval) are operator-only and essential
- declined: in-repo arming call sites (the orchestrator reconcile path, `resume-from-draft.ts`, `execute-pipeline.ts`) arm through a child-process `gh` call without the gate, which is pre-existing; routing them through `--arm` is recommended as AISDLC-663.5.1
- declined: text-level hook bypasses (`node -e` / `python -c` with argv arrays, a gh alias, `gh pr --repo o/r merge` reordering, graphql from a file, variable-expanded URLs, `eval`/base64); a static matcher cannot close them, a hardening that parses commands is recommended as AISDLC-663.5.2
- declined: forged commit statuses matched by name; needs branch protection pinning each required check to the GitHub Actions app (operator-only, H4)
- declined: authors of commits before the head commit are not checked; only the head commit author is
- declined: pushes made after arming are not bounded by the head re-read or `--match-head-commit`; GitHub keeps auto-merge enabled for pushes by users with write access
- declined: operator-token power; anything holding a merge-capable GitHub token outside the agent shell is outside this change
- declined: the task bind accepts a PR that adds its own task file (the repo creates and completes a task in one PR), so the task is a provenance hint and the author allow-list is the real trust signal
- declined: block the branch-merge API (`POST /repos/<o>/<r>/merges`) in the hook; a different endpoint, out of this task's scope
- declined: reconcile the CLAUDE.md "Never merge PRs" and `--auto` wording; that edit needs direct operator approval and is not made here
<!-- SECTION:FINAL_SUMMARY:END -->
