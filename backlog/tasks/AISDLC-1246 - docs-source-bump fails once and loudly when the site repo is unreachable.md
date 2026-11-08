---
id: AISDLC-1246
title: 'docs-source-bump.yml: unreachable site repository is reported once as an operator action, not as a red run on every push to main'
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - ci
  - docs
dependencies: []
references:
  - .github/workflows/docs-source-bump.yml
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
dispatchableReason: 'Filed by the planner on 2026-11-08. The workflow has failed on every push to main for at least the last 40 runs with "Could not resolve to a Repository with the name ai-sdlc-framework/ai-sdlc-io": the site repository is private and the workflow token cannot see it. Granting access is operator-only (class c, credentials); this task makes the workflow stop painting main red for a condition it cannot fix and surfaces the action once.'
---

## Description

**Gap.** `.github/workflows/docs-source-bump.yml` (AISDLC-859) opens a lockfile bump PR in the private site repository `ai-sdlc-framework/ai-sdlc-io` on every push to `main` that touches docs or spec. Since at least 2026-11-08 08:07Z every run fails in the "Open or update the bump PR" step with a GraphQL "Could not resolve to a Repository" error: the repository exists and is private, and the `GH_TOKEN` the workflow uses has no access to it. The failure is not actionable from this repository, repeats on every push (8 of 8 today), and sits in the run list next to real failures.

The reference to the private repository in a public workflow is itself a question for the operator: the workflow comment and `SITE_REPO` env name the private repo in a public file. This task does not decide that; it records the question for the operator and makes the behaviour correct either way.

## Fix

**Five-step review.**
1. Question: should the bump run from this repository at all, or should the site repository pull the pin on its own schedule (no cross-repo credential in the public repo)? Record as an open question for the operator in the PR body; implement the minimal fix below either way.
2. Delete: nothing yet.
3. Simplify: a preflight step `gh repo view "$SITE_REPO" --json name` whose failure writes one `::warning::` naming the operator action (grant the token or app access to the site repository, or move the bump into that repository), sets an output and skips the remaining steps with `if:`; the job ends green (neutral) instead of red.
4. Accelerate: none.
5. Automate: the stall digest / main-health monitor already tracks red runs on main; nothing further.

## Acceptance Criteria

- [ ] AC-1: when the site repository is not visible to the token, the run finishes green with one warning annotation naming the operator action, and no later step runs.
- [ ] AC-2: when it is visible, behaviour is unchanged (bump PR opened or updated).
- [ ] AC-3: the PR body records the open question (bump from here with a cross-repo credential, or pull from the site repository) for the operator; the task does not resolve it.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
