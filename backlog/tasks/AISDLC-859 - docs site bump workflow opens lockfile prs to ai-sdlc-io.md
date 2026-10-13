---
id: AISDLC-859
title: Workflow that opens a docs-source.lock.json bump PR in ai-sdlc-io when docs/ or spec/ change on main and arms it through cli-merge-if-eligible
status: To Do
assignee: []
created_date: '2026-10-13'
labels: [docs-platform, ci]
dependencies: [AISDLC-854]
references: [.github/workflows/ai-sdlc-gate.yml, .github/workflows/auto-enable-auto-merge.yml, scripts/is-docs-only-changeset.mjs, pipeline-cli/bin/cli-merge-if-eligible.mjs, docs/README.md]
priority: medium
dispatchable: true
---

## Description

**Five-step review (requirements first).** 1. Requirement questioned: that this repository pushes rendered docs into the site repository (`scripts/docs-sync.mjs`, set when the site was created); DEC-0001 in `ai-sdlc-io` inverts it to a pull at a pinned commit. 2. Deleted: nothing further to delete here; the push-sync scripts are deleted by AISDLC-853. 3. Simplified: this repository emits one signal, a lockfile bump PR, instead of transformed files. 4. Accelerated: a docs change landing on main reaches the site in one CI run plus the site build, with no manual sync. 5. Automated: the bump PR is opened, labelled and queued for landing by the workflow; nobody touches the site repo by hand.

DEC-0001 in `ai-sdlc-io` pins the site to a commit of this repository and relies on this repository to tell the site when to move the pin. Site task IO-1 defines the pin as `docs-source.lock.json` (`{ "repo": "ai-sdlc-framework/ai-sdlc", "sha": "<40-hex>" }`); site task IO-5 adds the required `site-build` PR check and sets the site's governance to `allowMerge: onGreenClean` so an armed PR can land. This task adds the producing side: a workflow that, on every push to `main` touching `docs/**` or `spec/**`, opens or updates one PR in `ai-sdlc-framework/ai-sdlc-io` that sets `sha` to the pushed commit, then arms it with `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --arm` run against the site repository. The helper is the only permitted arming path (it enforces policy, fork, author, base and head-commit checks); the workflow never calls the GitHub merge endpoints directly. This workflow lives under `.github/workflows/`, which the hierarchy brief treats as trust-sensitive; it is dispatchable but sequenced alone.

## Scope

1. `.github/workflows/docs-site-bump.yml`: trigger `push` to `main` with `paths: [docs/**, spec/**]`, plus `workflow_dispatch` with an optional `sha` input. Steps: check out `ai-sdlc-framework/ai-sdlc-io` with a token, write `docs-source.lock.json` with the pushed sha, commit to branch `docs-source/bump` (force-updated by the workflow so there is at most one open bump PR), open or update a PR titled `chore(docs): bump docs source to <short sha>` with body listing the docs/spec files changed since the previous lock sha (`git diff --name-only <old>..<new> -- docs spec`), apply label `docs-source-bump`, then run `cli-merge-if-eligible.mjs <pr> --arm` with the site checkout as the work dir so the PR lands when `site-build` is green.
2. Token: use `secrets.AI_SDLC_PAT` if the operator confirms it has `contents:write` and `pull_requests:write` on the private `ai-sdlc-io` repo (site task IO-5 step 4); otherwise read a new secret `AI_SDLC_IO_PAT`. The workflow must not run on forks or on `pull_request` events (the PAT is never exposed to untrusted contexts, same rule as `auto-enable-auto-merge.yml`).
3. Use `scripts/is-docs-only-changeset.mjs` or an equivalent path filter so a push that changes code but not docs/spec does not open a PR.
4. `docs/README.md`: one paragraph describing that merges to `main` propagate to the site through this bump PR, and how to trigger it by hand.
5. Tests: a node test for the PR-body generator (list of changed files between two shas, given a fixture `git diff --name-only` output).

Out of scope: the site-side check, governance setting and repository settings (IO-5); publishing scope (meta.json, AISDLC-854).

## Acceptance Criteria

- [ ] A push to `main` that touches `docs/` or `spec/` results in exactly one open PR on `ai-sdlc-framework/ai-sdlc-io` from branch `docs-source/bump` whose only diff is `docs-source.lock.json`, carrying label `docs-source-bump` and armed by `cli-merge-if-eligible --arm`.
- [ ] A second qualifying push before the first PR lands updates the same PR to the newer sha rather than opening another.
- [ ] A push to `main` that touches no `docs/` or `spec/` path does not trigger the workflow.
- [ ] `workflow_dispatch` with a `sha` input opens a bump PR for that sha.
- [ ] The PAT is referenced only from the `push`/`workflow_dispatch` job; the workflow has no `pull_request` trigger and no direct call to a GitHub merge endpoint.
