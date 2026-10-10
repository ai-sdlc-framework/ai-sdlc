---
id: AISDLC-799
title: >-
  GitHub Actions load discipline: auto-enable and untrusted-gate triggers that cannot flood the job queue, a deterministic `cli-ci sweep`, and queue-depth observability
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - stability
  - velocity
  - root-cause
dependencies: []
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/main-health-monitor.yml
  - ai-sdlc-plugin/commands/operator-dispatch.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incident (2026-10-10, 19:30-21:00 UTC).** With 17-20 PRs open and five executors pushing, the organisation's concurrent-job cap saturated: 100-144 runs queued, 6-10 running, oldest queued for 30+ minutes, and no PR merged for an hour. 59 of the queued runs were `Auto-enable auto-merge on PR open`, which fires on `synchronize` and on every `check_suite` completion even when the PR is already armed; 23-25 were the `Untrusted-Contributor PR Verification Gate`, which allocates a runner before deciding the PR is same-repo; 27 were on stale heads. The dispatch session cancelled 76 runs by hand with ad-hoc rules and, in doing so, cancelled a `pull_request_target` verify run that was not a duplicate and the auto-enable run that would have armed a new PR. AISDLC-727 (CI once per PR) halves the per-push job count but does not address the trigger fan-out.

**Root cause.** Workflows fire on events they do not need and allocate runners before cheap guards; there is no deterministic, tested sweep and no queue-depth signal, so the operator notices saturation only as missing merges.

**Five-step review (requirements first).** Three requirements go: auto-enable re-firing on `synchronize` and on every `check_suite` completion (an armed PR stays armed; the re-fire was added for a merge-queue race that no longer exists since AISDLC-400); the untrusted-contributor gate allocating a runner for same-repo PRs (its decision for them is constant); and, with AISDLC-727, CI running twice per PR. Delete those first. The `cli-ci sweep` and queue-depth signal are step 5 and are built only if saturation is still observed one week after the deletions land; write them as a conditional AC, not as default work.

**Fix.**
1. `auto-enable-auto-merge.yml`: trigger only on `opened`, `reopened` and `ready_for_review`; the `check_suite` and `synchronize` re-fires go, since GitHub keeps an armed PR armed across pushes. Add `concurrency: { group: auto-enable-${{ pr number }}, cancel-in-progress: true }`. Workflow tests updated.
2. `untrusted-pr-gate.yml`: a job-level `if:` on `github.event.pull_request.head.repo.full_name == github.repository` (and author association) skips every job for same-repo PRs before a runner is allocated; the result for same-repo PRs is unchanged (the gate is for external contributors).
3. New `node pipeline-cli/bin/cli-ci.mjs sweep [--dry-run]`: cancels queued runs that are (a) on a SHA that is no longer its PR's head, or (b) an older duplicate of the same workflow AND event AND branch. It never cancels a run on a current head, never cancels an auto-enable run for an unarmed PR, and prints what it cancelled and why. `cli-ci queue` prints queued/in-progress counts, per-workflow breakdown and oldest queued age. The dispatch command body calls `sweep` each board pass instead of ad-hoc `gh run cancel`.
4. `main-health-monitor.yml` (or the existing hourly digest) records `cli-ci queue` output; `ai-sdlc doctor` warns when queued > 40 or oldest queued > 15 minutes.

**Velocity impact.** Positive and large: the day's worst throughput loss. No governance surface changes; the untrusted gate's decision for same-repo PRs is identical, only earlier.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `auto-enable-auto-merge.yml` fires only on `opened`, `reopened`, `ready_for_review`, with a per-PR concurrency group; workflow tests assert the trigger set.
- [ ] `untrusted-pr-gate.yml` skips all jobs at the job level for same-repo PRs; a workflow test asserts the guard and a same-repo PR still receives whatever status it receives today.
- [ ] `cli-ci sweep` and `cli-ci queue` exist with hermetic tests covering the three never-cancel rules and the two cancel rules.
- [ ] The operator-dispatch command body uses `cli-ci sweep`; `ai-sdlc doctor` warns on queue depth and age thresholds.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 3 of the 2026-10-10 root-cause set. Related: AISDLC-727 (#1313), AISDLC-487 (merge starvation, low).
