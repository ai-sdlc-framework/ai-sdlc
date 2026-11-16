---
id: AISDLC-1283
title: '`ai-sdlc init` and `ai-sdlc doctor` use the repository target branch for branch protection, not a literal `main`'
status: In Progress
assignee: []
created_date: '2026-11-16'
labels:
  - orchestrator
  - adopter
  - bug
dependencies:
  - AISDLC-1282
references:
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - orchestrator/src/cli/commands/doctor.ts
  - orchestrator/src/cli/commands/init.ts
  - pipeline-cli/src/steps/02-compute-branch.ts
  - docs/operations/init.md
priority: medium
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2681). Verified by the planner in source at main 1ffab4a1: the PUT in `init-features.ts` and the GET in `branch-protection-shared.ts` both use the literal path `branches/main/protection`. The operator chose the branch source on 2026-11-16: `spec.branching.targetBranch` when set, otherwise the default branch reported by `gh repo view`. Depends on AISDLC-1282, which edits the same next-steps function.'
---

## Description

**Gap (issue #2681).** `ai-sdlc init` applies branch protection to a branch named `main`, and `ai-sdlc doctor` reads it from `main`, whatever branch the repository uses:

- PUT `repos/<slug>/branches/main/protection` in `orchestrator/src/cli/commands/init-features.ts` (about lines 1924-1931); the dry-run text, the success line and the next-steps line also say `main`;
- GET `repos/<slug>/branches/main/protection` in `orchestrator/src/cli/commands/branch-protection-shared.ts` (about lines 139-142), and its error text;
- messages in `orchestrator/src/cli/commands/doctor-checks.ts` (about line 627) and `doctor.ts` (about lines 290-297).

On a repository whose default branch is `master`, init fails to apply protection and doctor reports it as not configured. The onboarding guide tells adopters to be on "`main` (or `master`)".

**Shape.** One resolver, used by init and doctor, returns the branch to protect:

1. `spec.branching.targetBranch` in `.ai-sdlc/pipeline.yaml`, when set;
2. otherwise the default branch of the repository, read in the existing `gh repo view` call (`--json nameWithOwner,defaultBranchRef`);
3. otherwise `main`.

`resolveTargetBranch` in `pipeline-cli/src/steps/02-compute-branch.ts` cannot be used as it is for step 1: it returns `main` when the key is unset, so "unset" and "set to main" look the same. Read the key directly, or add a variant that reports "unset".

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the branch be configurable at all? Yes: pull requests merge into the target branch, and that is where protection has to be. 2. Deleted: the literal `main` in the two API paths and in the messages about them. 3. Simplified or optimised: one resolver in `branch-protection-shared.ts`, and no extra `gh` call (the existing `gh repo view` gains one field). 4. Accelerated: n/a. 5. Automated: tests with a fake `gh` for `main` and `master` repositories.

- Add the resolver to `branch-protection-shared.ts` next to `resolveOwnerRepoSlug`, and use it for the PUT in init and the GET in doctor.
- Messages name the branch used: the "applied branch protection" line, the next-steps line, the doctor error text and remediation text.
- Dry-run still makes no `gh` call (a test pins that). Its text names `spec.branching.targetBranch` when the key is set, and otherwise shows `{branch}`.
- `docs/operations/init.md` and the `--with-branch-protection` option help in `init.ts`: say which branch is protected and how it is chosen.

## Acceptance Criteria

- [ ] #1 On a repository whose default branch is `master` and with `spec.branching.targetBranch` unset or `master`, `ai-sdlc init --with-branch-protection` sends its PUT to `branches/master/protection`; a test with a fake `gh` asserts the path.
- [ ] #2 On the same repository, doctor's `attestation-governance` check reads `branches/master/protection` and reports what it reports today for a `main` repository with the same protection settings; a test covers it.
- [ ] #3 With `spec.branching.targetBranch: develop` and a default branch of `main`, both calls use `branches/develop/protection`; a test covers it.
- [ ] #4 On a repository whose default branch is `main` and whose `spec.branching.targetBranch` is `main` or unset, both calls use `branches/main/protection` as today; existing tests pass.
- [ ] #5 When `gh repo view` returns no default branch, both calls fall back to `main`; a test covers it.
- [ ] #6 The "applied branch protection" line and the next-steps line name the branch used. The dry-run text names the configured target branch or shows `{branch}`, and makes no `gh` call.
- [ ] #7 The PR body carries `Closes #2681`.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
