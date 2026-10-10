---
id: AISDLC-802
title: >-
  After a `.github/workflows/**` change lands on main, open PRs are refreshed by a rebase push, never a re-run; `cli-ci stale-workflow-prs` lists them and dispatch queues the resumes
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - dispatch
  - stability
  - velocity
  - root-cause
dependencies: []
references:
  - .github/workflows/main-health-monitor.yml
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - docs/operations/merge-without-queue.md
priority: low
dispatchable: false
dispatchableReason: "Withdrawn after the five-step review: folded into the AISDLC-800 note template; no separate build."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incident (2026-10-10, 21:34-22:00 UTC).** After the drift-gate fix (AISDLC-796) merged, dispatch re-ran the failed jobs on four PRs and the planner cycled three PRs draft → ready to force fresh runs. All of them still executed the old workflow step and failed again: a re-run uses the original run's ref and workflow-file version, and the fresh runs were evaluated against a merge ref computed before main changed. Half an hour and two rounds of guesswork were lost before the PRs were queued for a real rebase.

**Root cause.** No documented or automated rule says that a workflow-file change on main only reaches an open PR through a push to that PR's branch, and nothing lists which open PRs are stale relative to the last workflow change.

**Five-step review (requirements first).** This task is withdrawn as separate work: once no single gate can fail every PR (the drift-gate deletion in this set), a stale workflow version on an open PR is harmless (branch protection is `strict=false`; the PR merges on its own green run). The one-sentence rule "a workflow change reaches an open PR only through a push to that PR's branch" goes into the operator-dispatch playbook as part of AISDLC-800's note template, and nothing else is built. Marked non-dispatchable.

**Fix.**
1. `node pipeline-cli/bin/cli-ci.mjs stale-workflow-prs`: finds the newest commit on `origin/main` touching `.github/workflows/**`, `scripts/check-*.sh` or `scripts/check-*.mjs`, and lists every open same-repo PR whose merge-base with main predates it, with the task id derived from the branch. `--enqueue-resumes` writes a resume for each dispatchable one with the generated note "rebase onto main to pick up <sha> (<workflow files>); no code change expected".
2. The operator-dispatch command body runs it after every merge whose files include a workflow or gate script (it already polls merges) and queues the resumes ahead of new backlog work. The playbook text states the rule: re-run and draft/ready cycles never refresh a PR's workflow version.
3. `docs/operations/merge-without-queue.md` documents the rule and the command.

**Velocity impact.** Positive: a workflow fix propagates to every open PR within one board pass instead of per-PR diagnosis.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `cli-ci stale-workflow-prs` lists open PRs whose merge-base predates the last workflow or gate-script commit on main, with hermetic tests over a temp repo and a stubbed PR list.
- [ ] `--enqueue-resumes` writes resume manifests with a generated note and no wave; tested.
- [ ] The operator-dispatch command body calls it after a workflow-touching merge and states the never-rerun rule.
- [ ] `docs/operations/merge-without-queue.md` documents the behaviour.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 6 of the 2026-10-10 root-cause set. Shares `cli-ci` with AISDLC-799; whichever lands first creates the bin.
