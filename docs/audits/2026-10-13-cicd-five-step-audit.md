# Audit: CI/CD under the five-step algorithm, 2026-10-13

**Date:** 2026-10-13 · **Author:** audit session, on operator instruction (Dominique) · **Status:** findings and proposed tasks; nothing is changed by this document. Follows the AISDLC-805 gate audit (`docs/operations/gate-audit-2026-10.md`, DEC-0095..0109).

Operator mandate: "We are accumulating way too much stuff on CI/CD that's slowed the PRs to a dead crawl. Go through everything on the CI/CD list and apply the five-step algorithm to it; everything must be absolutely necessary."

## 1. Summary

The repository carries 25 workflows with 71 jobs, a 14-job `ai-sdlc/pr-ready` rollup, 2 required branch-protection contexts, 4 husky hooks (11 scripts chained from `pre-push`, 3 steps in `pre-commit`), a 123-file gate-test suite and 7 `pnpm test` meta checks. In the 7 days to 2026-10-13 04:19Z GitHub recorded 10,726 workflow runs (at the 1000-run API cap for 7 workflows, so those windows are shorter than 7 days). 26 percent of runs were skipped, 18 percent were cancelled, 5 percent failed and 51 percent passed. Estimated billable runner time is about 18,900 runner-minutes a week (sampled job durations times run counts); summed run wall clock is 58,044 minutes because it includes runner-queue wait between jobs (for `untrusted-pr-gate.yml` the wall median is 485 s against 59 s of job time). The previous audit decided 15 changes on 2026-10-11; **13 of the 15 are not implemented, 1 is partial and 1 is done**, and no implementing task was filed for any of them. The crawl is not mainly CI duration: a code PR reaches `ai-sdlc/pr-ready` green 9 to 14 minutes after its last push (median 13.0 minutes over the last 5 code PRs, long pole Build & Test then Coverage in parallel), but PR lifetime from creation to merge has a median of 42 minutes and a 75th percentile of 6 hours, and 17 of the last 80 merged PRs took 12 hours or more. Of the 14 PRs open on 2026-10-13, 12 are red, conflicting or blocked, the oldest 6 days. The wait is executor-side landing (rebase, re-sign, requeue cap), with CI a secondary cost; the CI/CD fix is to stop paying for work that is skipped, cancelled, duplicated or never reads a result.

Headline numbers:

| Measure | Value |
|---|---|
| Workflows / jobs | 25 / 71 |
| Hook scripts | 4 husky hooks; 11 scripts chained from `pre-push`, 3 steps in `pre-commit`, plus lint-staged |
| Runs, last 7 days | 10,726 (51% success, 26% skipped, 18% cancelled, 5% failed) |
| Runner minutes, last 7 days | about 18,900 estimated (job time); 58,044 run wall clock (includes queue wait) |
| Median PR critical path (last push to `pr-ready` green, 5 code PRs) | 13.0 min (range 9.1 to 13.9) |
| Median PR lifetime (created to merged, last 80 merged PRs) | 42 min; p25 12 min; p75 356 min; 17 of 80 over 12 h |
| Previous audit decisions not implemented | 13 of 15 (1 partial, 1 done) |

## 2. Method and limits

- Runs: `gh api repos/{owner}/{repo}/actions/workflows/<file>/runs?created>=2026-10-06T04:19Z`, one query per workflow, 2026-10-13. **The API returns at most 1000 runs per query**: `ai-sdlc-gate`, `ai-sdlc-review`, `ai-sdlc-fix-ci`, `auto-enable-auto-merge`, `require-issue-link`, `untrusted-pr-gate` and `verify-attestation` hit the cap, so their windows start 2026-10-07 to 2026-10-11 and their weekly figures are lower bounds.
- "Wall minutes" = sum of `updated_at - run_started_at` for success, failure and cancelled runs (capped at 3 h each). It overstates compute because it includes runner-queue gaps between jobs. "Runner minutes" = runs times the mean of summed non-skipped job durations in a sample of 6 runs per workflow (cancelled runs weighted at half). It is an estimate, not a bill; the Actions billing API was not used.
- Failure classification: a failure is "flake or skew" when the same head SHA has a later success in the sample (lower bound), or when the failure log shows the head-moved race guard (UCVG, below). Fixed-by-rebase failures cannot be seen and count as real.
- Job table: the last 60 completed `ai-sdlc-gate` runs. Critical path: 5 most recent merged code PRs (#1450, #1442, #1439, #1436, #1435), last commit date to the `ai-sdlc/pr-ready` check-run `completed_at`.
- Hooks write no run history: local cost is not measured and is stated from what the script does.
- Origins come from `git log --diff-filter=A --follow` (first commit of the file) and the task ids cited in the file.

## 3. Previous-audit reconciliation (D1 to D15)

Source: `.ai-sdlc/_decisions/events.jsonl`, DEC-0095..0109, all answered 2026-10-11 16:00Z (D8 and D14 are DEC-0108 and DEC-0109, answered with the same batch). Only DEC-0092 and the gate registry (`.ai-sdlc/gates.yaml`, glob test runner) landed from AISDLC-805. **No task in `backlog/` cites DEC-0095..0109 other than the completed AISDLC-818 mention**, so the 13 undone decisions have no owner.

| D | Decision (DEC) | Chosen | Implemented on main today? | Evidence |
|---|---|---|---|---|
| D1 | Delete `isolated-review.yml` (DEC-0095) | delete | **No** | file present; 950 runs in 7 days, 949 skipped, 1 failure |
| D2 | Fold `verify-attestation.yml` into `attestation-gate`, single trigger (DEC-0096) | fold | **No** | file present, 719 lines; 392 `pull_request` plus 608 `pull_request_target` runs |
| D3 | Fold PR half of `dor-ingress.yml` into `dor-readiness-gate` (DEC-0097) | fold | **No** | `evaluate-pr-tasks` job still in `dor-ingress.yml`; 582 runs, 193 skipped |
| D4 | Drop `pull_request` trigger of `ai-sdlc-review.yml` (DEC-0098) | drop-trigger | **No** | both triggers present; 498 `pull_request` plus 502 `pull_request_target`; 720 of 1000 runs cancelled. Open PR #1453 (AISDLC-824) goes further and is DIRTY |
| D5 | Delete `auto-rearm-on-dequeue.yml`, add rollback line (DEC-0099) | fold | **No** | file present; 873 runs (841 per push, 32 cron); `merge-without-queue.md` still says the file "is kept" |
| D6 | First-run smoke on matching paths plus nightly plus dispatch (DEC-0100) | third option | **No** | `first_run` path filter in `ai-sdlc-gate.yml:169` still lists `pipeline-cli/**`, `orchestrator/**`, `reference/**`, `README.md`, so it ran on 29 of 60 sampled gate runs; nightly exists in `ci.yml` (AISDLC-771) but the per-PR filter was not narrowed |
| D7 | Require only `ai-sdlc/pr-ready` (DEC-0101) | drop-context | **No** | branch protection still lists `Backlog Drift` and `ai-sdlc/pr-ready` |
| D8 | Reconcile `strict` sentence in CLAUDE.md (DEC-0108) | strict-true | **Yes (incidental)** | CLAUDE.md is now 76 lines and no longer contains the contradictory sentence (AISDLC-651.2); live setting is `strict: false` |
| D9 | Dedupe pre-push invocations, fold squash into fixups (DEC-0102) | dedupe | **No** | `.husky/pre-push` still calls `pre-push-fixups.sh`, then `check-task-moved.sh` and `check-attestation-sign.sh` directly; `squash-attestation-chores.sh` still separate |
| D10 | Delete `check-changelog-edit.sh` (DEC-0103) | delete | **No** | script and its `.husky/pre-push` call present |
| D11 | Move `typecheck-workspace.mjs` to pre-push (DEC-0104) | move | **No** | `.husky/pre-commit:15` still runs it |
| D12 | Trim CLAUDE.md via AISDLC-742 (DEC-0105) | trim | **Partial** | size cut to 15 KB by AISDLC-651.2 (#1345), but the named deletions remain: `## CI marker hygiene` (line 14), the feature-flag line (47), the read-only-agents line (75); AISDLC-742 (#1248) is open, 6 days old, red |
| D13 | Fold paired `**/opencode*` and `git branch -d/-D` entries (DEC-0106) | fold with test | **No** | `.ai-sdlc/agent-role.yaml` lines 45 to 50 and 63 to 64 unchanged |
| D14 | Diagnose `untrusted-pr-gate.yml` failure rate (DEC-0109) | diagnose | **No (no diagnosis filed); diagnosed here** | 336 of 1000 runs failed. 20 of 20 sampled failures are the `Governance boundary` job exiting 1 on "PR head moved ... a newer run will re-evaluate". The workflow has no `concurrency` group, so each push leaves a failing superseded run. See finding F6 |
| D15 | Delete `ai-sdlc-fix-ci.yml` (DEC-0107) | delete | **No** | file present; 1000 runs, 999 skipped, 0 successes |

Count: **13 decided and not implemented, 1 partial (D12), 1 done (D8).** This is a first-class finding: the previous audit produced decisions, and the loop that turns a decision into a merged change did not exist for them. Proposed task T1 below implements all 13 as one tracked batch.

## 4. Findings

- **F1. The crawl is landing, not CI.** Code PRs go green in 9 to 14 minutes after the last push. Creation to merge: #1450 37 min, #1442 9 min, #1439 264 min, #1436 62 min, #1435 262 min; the PRs that took hours spent them on rebase, re-sign and requeue passes, not on checks (the hour-scale ones have 13 minute CI). Of the 14 PRs open on 2026-10-13: 4 are DIRTY (#1453, #1368, #1360, #1346), 8 carry a failed required check (#1449, #1446, #1445, #1443, #1441, #1407, #1389, #1248), the release PR #1320 is BLOCKED and the oldest (#1248) is 6 days old. This matches the 2026-10-11 pile-up audit (Finding 1: no owner follows a PR until it lands) and is tracked by AISDLC-816, 823 and 829. CI work below is worth doing for cost and noise, but it will not by itself end the crawl.
- **F2. Coverage re-runs the same suite.** `ai-sdlc-gate.yml` `build-test` (line 187) runs `pnpm install`, `pnpm build`, `pnpm test`; `coverage` runs `pnpm install`, `pnpm build`, `pnpm test:coverage` on a second runner. On #1450 the gate took 13 min: Build & Test (Node 22) 527 s and Coverage 356 s, in parallel. Over the 60-job sample the two jobs are 35 and 32 percent of all gate job time, roughly 6,300 of about 9,500 gate runner-minutes a week. A single job running the suite once with coverage on removes one install, one build and one full test run per PR push. Candidate verdict: FOLD Coverage into Build & Test.
- **F3. CodeQL Go runs on every PR and costs 2 minutes.** `Analyze (go)` ran 104 s and 127 s on #1450 (default setup, so no workflow file; `code-scanning/default-setup` lists `actions, go, javascript-typescript, python`). Correction to the working note that the repo has no Go: `sdk-go/` holds 96 `.go` files and `Test Go SDK` is path-gated to it. The cost is that CodeQL Go is not path-gated, unlike the SDK test. Candidate verdict: SIMPLIFY (path-gate or weekly-only for Go and Python via advanced setup), not drop; it weakens a scan, so it is an operator decision (decision 12).
- **F4. Every push fires 9 to 10 workflows, most of which skip.** On #1450 the head SHA carries check runs from DoR Ingress, PR Ready Gate, Verify Attestation (twice, two triggers), Auto-enable (twice), Auto-rearm (twice), Review, Isolated Review, Require Linked Issue, Untrusted-Contributor Gate (twice), plus CodeQL; about 30 of the 70 check rows are skipped or cancelled. Workflow-level skip rates over 7 days: `ai-sdlc-fix-ci` 100%, `isolated-review` 100%, `require-issue-link` 33%, `dor-ingress` 33%, `verify-attestation` 31%. Cancellation: `ai-sdlc-gate` 505 of 1000, `ai-sdlc-review` 720 of 1000, `ci` 319 of 685. Each skipped workflow still costs a queue slot, and the runner queue is the visible latency: `auto-enable-auto-merge.yml` has 5 s of job time per run and a 64 s median wall time; 624 of its 1000 runs are `check_suite` events.
- **F5. Docs-only versus code PRs.** Docs-only PRs take 2 to 3 minutes (detect, lint, drift, DoR, rollup); code PRs take 13 to 14 minutes and 47 to 87 runner-minutes. The expensive 75 percent is two jobs (F2).
- **F6. `untrusted-pr-gate.yml` reports false failures and costs the most wall clock.** 336 of 1000 runs failed, 20 of 20 sampled failures are the race guard in the `Governance boundary` job ("PR head moved ... a newer run will re-evaluate") and the step then posts a `failure` commit status reading "a fork changes governance config or workflows" on the old SHA. There is no `concurrency` group, so superseded runs are neither cancelled nor harmless. The run wall total is the largest in the repository (19,358 minutes) against about 950 runner-minutes of job time: the trust-classification job runs on every PR even though the flag is off (`UCVG: flag off (skipped)` is the job that runs). Open PR #1389 (AISDLC-799) makes UCVG fork-only; it is DIRTY and blocked on `Attestation gate`.
- **F7. `ci.yml` and `main-health-monitor.yml` both run the full suite on every push to main.** 204 pushes in 7 days; `ci.yml` push runs plus nightly are about 2,300 runner-minutes of its 5,855 (the remainder is stale `pull_request` runs from branches carrying the pre-AISDLC-727 file, last seen 2026-10-10), and `main-health-monitor.yml` adds about 930. Same property, two workflows (merge-skew detection, AISDLC-406).
- **F8. Dead triggers and idle workflows.** `merge-queue-passthrough.yml` has had no run since 2026-05-23 (queue dropped by AISDLC-400). The six February/March dogfood issue workflows (`ai-sdlc.yml`, `ai-sdlc-admit/route/triage/sa-feedback/slack-issue.yml`) had 0 runs in 7 days; last runs 2026-10-05 (admit), 2026-09-15 (others) and 2026-03-28 (slack). `scorecard.yml` runs on every main push (204 runs, 146 runner-minutes) while its own weekly cron is the useful part.
- **F9. Stated wiring that is not wired.** `pnpm lint:publishable` was documented as wired into `pnpm test` (CLAUDE.md before AISDLC-651.2) and CLAUDE.md still tells contributors to run it; no workflow and no `test` chain entry calls it (`grep` finds only the package.json definition and its unit test). The `post-rewrite` hook cannot act in the Pattern C steady state it exists for: it returns early when the parent has `main` checked out, and the parent is required to be on `main` at all times (AISDLC-358).
- **F10. Registry and meta-test cost is low.** The glob runner replaced a 58-entry chain with 123 discovered files and is the right shape; `rfc:check`, `dark-code:check`, `knowledge:check` and `sync:plugin-runtime-deps:check` are static scans that run once inside Build & Test.

## 5. Five-step review (requirements first)

1. **Requirement questioned.** "Every PR gets every check, from every workflow that ever protected a PR" was set one task at a time (AISDLC-74, 140, 214, 381, 388, 400, 443, 501, 727, 771) and never re-asked as a set. The requirement that survives is: one required rollup, run once per push, that fails only for a real defect. The operator mandate of 2026-10-13 re-asks it as a set. The decision loop gap (F1, section 3) is a requirement too: "decided means done" was never owned.
2. **Delete.** Workflows that never produce a result (isolated-review, fix-ci, merge-queue-passthrough, six idle issue workflows), a trigger leg that cancels itself (ai-sdlc-review `pull_request`), a post-queue workflow (auto-rearm), a warn-only hook (changelog), a no-op hook (post-rewrite). About 2,000 jobs-skipped-per-week disappear with no control lost.
3. **Simplify.** One attestation verification run, one DoR evaluation, one auto-merge arming workflow, one main-push suite, one orchestrator for pre-push fixups, one test+coverage job, concurrency groups on every PR-triggered workflow.
4. **Accelerate.** After the above: shard the test run (the only remaining long pole is the single 8 minute job), narrow `first-run-smoke` paths, path-gate CodeQL Go. Not before.
5. **Automate.** A task and a tracker for every recorded decision (so D1 to D15 cannot sit undone again); `cli-ci` sweep (AISDLC-799/802) to refresh stale runs; the registry ratchet already exists.

Velocity impact: positive by construction. Every DELETE and FOLD below removes a runner queue slot or a duplicate execution; the only items with a latency cost are none, and the only item that weakens a scan is the CodeQL Go path gate, which is a decision.

## 6. Workflow minutes, last 7 days

Sorted by estimated runner minutes. "Wall" is the sum of run durations (see section 2). Runs capped at 1000 are marked with `*`.

| Workflow | Runs | Success / fail / cancel / skip | Est. runner min | Wall min | Median wall (done runs) |
|---|---|---|---|---|---|
| `ai-sdlc-gate.yml` | 1000* | 352 / 140 / 505 / 0 | 9,538 | 9,753 | 698 s |
| `ci.yml` | 685 | 310 / 55 / 319 / 0 | 5,855 | 5,586 | 455 s |
| `untrusted-pr-gate.yml` | 1000* | 600 / 336 / 62 / 0 | 956 | 19,358 | 485 s |
| `main-health-monitor.yml` | 206 | 155 / 9 / 41 / 0 | 933 | 1,505 | 385 s |
| `ai-sdlc-review.yml` | 1000* | 280 / 0 / 720 / 0 | 427 | 6,568 | 359 s |
| `verify-attestation.yml` | 1000* | 509 / 0 / 181 / 308 | 368 | 2,997 | 136 s |
| `dor-ingress.yml` | 582 | 335 / 13 / 40 / 193 | 218 | 1,514 | 114 s |
| `release.yml` | 204 | 168 / 3 / 33 / 0 | 149 | 909 | 130 s |
| `scorecard.yml` | 205 | 205 / 0 / 0 / 0 | 146 | 623 | 66 s |
| `require-issue-link.yml` | 1000* | 663 / 0 / 7 / 329 | 89 | 2,439 | 96 s |
| `auto-enable-auto-merge.yml` | 1000* | 998 / 1 / 0 / 0 | 83 | 3,698 | 64 s |
| `auto-rearm-on-dequeue.yml` | 873 | 849 / 19 / 5 / 0 | 80 | 3,062 | 78 s |
| `flaky-tests.yml` | 7 | 7 / 0 / 0 / 0 | 11 | 9 | 81 s |
| `rfc-lifecycle-check.yml` | 13 | 9 / 1 / 0 / 3 | 4 | 16 | 26 s |
| `trusted-reviewers-drift.yml` | 1 | 1 / 0 / 0 / 0 | 1 | 6 | 383 s |
| `isolated-review.yml` | 950 | 0 / 1 / 0 / 949 | 0 | 0 | n/a |
| `ai-sdlc-fix-ci.yml` | 1000* | 0 / 0 / 1 / 999 | 0 | 0 | n/a |
| `merge-queue-passthrough.yml`, `consumer-verify-attestation.yml`, `ai-sdlc.yml`, `ai-sdlc-admit/route/triage/sa-feedback/slack-issue.yml` | 0 | none in 7 days | 0 | 0 | n/a |
| **Total** | **10,726** | 5,441 / 578 / 1,914 / 2,781 | **about 18,900** | **58,044** | |

Gate jobs (last 60 completed `ai-sdlc-gate` runs): Build & Test 512 s median, 8 of 34 failed; Coverage 500 s, 6 of 34 failed, 26 skipped; Lint 98 s; Integration 115 s; First-run smoke 54 s (29 ran, 2 failed, 29 skipped); Backlog Drift 25 s; Test Go 96 s (8 ran); DoR 4 s; Attestation gate 4 s; Independence 8 s; Dependency review 9 s; Python SDK 22 to 24 s per version (8 ran); `pr-ready` 3 s (18 of 46 failed, as a rollup it fails when any job does).

## 7. Critical path, five most recent merged code PRs

| PR | Created to merged | Last commit to `pr-ready` green | Long poles (parallel) |
|---|---|---|---|
| #1450 dispatch tick reaps stalled executors | 37 min | 13.4 min | Build & Test 527 s, Coverage 356 s |
| #1442 github-actions group bump | 9 min | 9.1 min | Coverage 510 s, Build & Test 411 s |
| #1439 gitignore parent runtime state | 264 min | 13.0 min | Build & Test 528 s, Coverage 518 s |
| #1436 lease-push preflight | 62 min | 9.2 min | Coverage 511 s, Build & Test 402 s |
| #1435 cli-file validates planner records | 262 min | 13.9 min | Build & Test 638 s, Coverage 398 s |

Median last-push-to-green 13.0 min; the long pole is always the Build & Test / Coverage pair (the two jobs run in parallel on separate runners, so folding them saves runner minutes, not wall time; sharding the single test run is what shortens the path). For the 80 most recent merged PRs the created-to-merged median is 42 min, p75 356 min, maximum 2,787 min (46 h).

## 8. Inventory

Columns: item; `file:line`; trigger; protects and who set it (origin); 7-day cost and failure profile; verdict. "Loosens" = DELETE or MOVE removes or weakens a gate, required check, hook, review or attestation requirement.

### 8.1 Workflows (A)

| Item | file:line | Trigger | Protects / origin | 7-day cost, failures | Verdict | Loosens |
|---|---|---|---|---|---|---|
| `ai-sdlc-gate.yml` (14 jobs, see 8.2) | `.github/workflows/ai-sdlc-gate.yml:1` | `pull_request` (4 types); concurrency per PR | one CI run per PR rolling to `pr-ready`; AISDLC-140, 727, DEC-0056 | 9,538 min, 1000 runs, 505 cancelled, 140 failed (7 of 140 same-SHA later green = flake or skew) | KEEP, FOLD Coverage into Build & Test, SIMPLIFY (shard) | no |
| `ai-sdlc-review.yml` (6 jobs) | `.github/workflows/ai-sdlc-review.yml:1` | `pull_request` plus `pull_request_target` | CI-side reviewers when no local attestation; AISDLC-381, 141 | 427 min, 720 of 1000 cancelled, 0 failures | SIMPLIFY now (D4: drop `pull_request`); MOVE to untrusted-only (open #1453, AISDLC-824) | yes (reviewer fallback for trusted PRs) |
| `verify-attestation.yml` (2 jobs) | `.github/workflows/verify-attestation.yml:1` | `pull_request` plus `pull_request_target` | DSSE attestation verifies; AISDLC-74, 214, 388 | 368 min, 181 cancelled, 308 skipped, 0 failures | FOLD into `attestation-gate` (D2) | no |
| `dor-ingress.yml` (2 jobs) | `.github/workflows/dor-ingress.yml:1` | `issues`, `pull_request` (paths) | DoR on task files; RFC-0011, AISDLC-115.4, 379 | 218 min, 193 skipped, 13 failed | FOLD PR half into `dor-readiness-gate` (D3) | no |
| `untrusted-pr-gate.yml` (7 jobs) | `.github/workflows/untrusted-pr-gate.yml:1` | `pull_request_target` (5 types) | untrusted authors cannot change governance paths; RFC-0043 P5, AISDLC-501, 720.1, 740 | 956 min job time, 19,358 wall, 336 failed = race-guard artifacts | SIMPLIFY: add `concurrency` cancel-in-progress, fork-only (AISDLC-799); KEEP `governance-boundary` | no |
| `isolated-review.yml` (2 jobs) | `.github/workflows/isolated-review.yml:1` | `pull_request` (4 types) | RFC-0047 Phase 4 isolated review; AISDLC-596 | 0 min, 949 of 950 skipped, 0 successes | DELETE (D1) | yes (decided) |
| `ai-sdlc-fix-ci.yml` (2 jobs) | `.github/workflows/ai-sdlc-fix-ci.yml:1` | `workflow_run` | CI fix loop; added 2026-02-08 | 0 min, 999 of 1000 skipped | DELETE (D15) | yes (decided) |
| `auto-enable-auto-merge.yml` (1 job) | `.github/workflows/auto-enable-auto-merge.yml:1` | `pull_request_target`, `check_suite`, `status` | arms squash auto-merge; AISDLC-381, 400 | 83 min, 64 s wall, 624 `check_suite` plus 27 `status` runs | SIMPLIFY: drop `check_suite` and `status` triggers (open #1389) | no |
| `auto-rearm-on-dequeue.yml` (1 job) | `.github/workflows/auto-rearm-on-dequeue.yml:1` | `pull_request_target`, 5-minute cron | re-arm after queue dequeue; AISDLC-369, 400 | 80 min, 873 runs, 19 failed | DELETE (D5) | no (no queue exists) |
| `require-issue-link.yml` (1 job) | `.github/workflows/require-issue-link.yml:1` | `pull_request_target` (7 types) | external PRs link an issue; AISDLC-443, 477, 700 | 89 min, 329 skipped, 0 failures | SIMPLIFY: external PRs only, drop `edited/labeled/unlabeled` types | no |
| `rfc-lifecycle-check.yml` (1 job) | `.github/workflows/rfc-lifecycle-check.yml:1` | `pull_request` (paths), `merge_group` | RFC ladder; AISDLC-350, 417 | 4 min, 13 runs, 1 failed | KEEP (drop dead `merge_group` leg) | no |
| `ci.yml` (9 jobs) | `.github/workflows/ci.yml:1` | `push` main, `merge_group`, nightly | post-merge and nightly suite; AISDLC-727 | 5,855 min incl. stale PR-event runs; ~2,300 for 204 pushes | FOLD push leg into `main-health-monitor.yml`, keep nightly | no |
| `main-health-monitor.yml` (3 jobs) | `.github/workflows/main-health-monitor.yml:1` | `push` main, daily cron | merge-skew on main; AISDLC-406, 797 | 933 min, 41 cancelled, 9 failed | KEEP (absorbs `ci.yml` push) | no |
| `release.yml` (5 jobs) | `.github/workflows/release.yml:1` | `push` main, dispatch | release-please rolling PR, npm and PyPI publish; AISDLC-401 | 149 min, 204 runs, 33 cancelled | KEEP | no |
| `scorecard.yml` (1 job) | `.github/workflows/scorecard.yml:1` | `push` main, weekly cron, branch-protection event | OpenSSF Scorecard; supply-chain hardening 2026-05-30 | 146 min, 204 runs, 0 failures | MOVE to weekly cron only | yes (posture report, not a PR gate; decision 11) |
| `flaky-tests.yml` (1 job) | `.github/workflows/flaky-tests.yml:1` | daily cron, dispatch | flake convention; AISDLC-371 | 11 min, 7 runs | KEEP | no |
| `trusted-reviewers-drift.yml` (2 jobs) | `.github/workflows/trusted-reviewers-drift.yml:1` | weekly cron, dispatch | trusted-reviewers vs GitHub permissions; AISDLC-497 | 1 min, 1 run | KEEP | no |
| `consumer-verify-attestation.yml` (1 job) | `.github/workflows/consumer-verify-attestation.yml:1` | `workflow_call` | adopter reusable verify; AISDLC-757 | 0 runs (called by adopters) | KEEP | no |
| `merge-queue-passthrough.yml` (1 job) | `.github/workflows/merge-queue-passthrough.yml:1` | `merge_group` | queue review stub; 2026-04-28 | 0 runs since 2026-05-23 | DELETE | no |
| `ai-sdlc.yml` (2 jobs) | `.github/workflows/ai-sdlc.yml:1` | `issues` labeled | label-driven agent; 2026-02-08 | 0 runs in 7 days; last 2026-09-15 | DELETE (the API-key path is `dogfood watch`) | no (capability, not a gate; decision 9) |
| `ai-sdlc-admit.yml` (1 job) | `.github/workflows/ai-sdlc-admit.yml:1` | `issues` opened, edited | issue admission score; 2026-03-28 | 0 runs in 7 days; last 2026-10-05 | DELETE or MOVE to on-demand | no (decision 9) |
| `ai-sdlc-route.yml`, `ai-sdlc-triage.yml`, `ai-sdlc-sa-feedback.yml`, `ai-sdlc-slack-issue.yml` | `.github/workflows/<name>:1` | `issues` labeled / `repository_dispatch` | triage and routing for the label pipeline; 2026-03 to 2026-04 | 0 runs in 7 days; last 2026-09-15, slack 2026-03-28 | DELETE (together with `ai-sdlc.yml`) | no (decision 9) |
| CodeQL (default setup, no file) | repo settings, `code-scanning/default-setup` | PR, push, weekly | code scanning; default setup | `Analyze (go)` 104 to 127 s, `javascript-typescript` 106 to 192 s per push | SIMPLIFY: path-gate Go and Python | yes (decision 12) |
| Dependabot | `.github/dependabot.yml:13,69` | weekly | dependency bumps | spawns ~5 PRs per week, each runs the full gate | KEEP; SIMPLIFY by grouping (already grouped) | no |

### 8.2 Required and rollup checks (B)

Branch protection `main` (`required_status_checks`, `strict: false`): `Backlog Drift`, `ai-sdlc/pr-ready`. Gate registry: `.ai-sdlc/gates.yaml` (391 lines, shrink-only, ratchet test `scripts/check-gate-registry.test.mjs`; AISDLC-805).

| Item | file:line | Runs when | Protects / origin | Cost, failure | Verdict | Loosens |
|---|---|---|---|---|---|---|
| `ai-sdlc/pr-ready` | `ai-sdlc-gate.yml:640` | every non-draft PR push | the single rollup; AISDLC-388 | 3 s; fails with any job | KEEP | no |
| `Backlog Drift` context | branch protection | every PR | tasks resolve; AISDLC-125 | 25 s, 2 of 46 | DELETE the extra required context (D7); job stays in the rollup | yes (decided) |
| `detect` | `ai-sdlc-gate.yml:98` | every PR | classify docs-only and affected paths | 9 s | KEEP | no |
| `lint` | `ai-sdlc-gate.yml:178` | every PR | eslint, prettier, clock discipline; AISDLC-140 | 98 s, 3 of 60 | KEEP | no |
| `build-test` | `ai-sdlc-gate.yml:187` | code PRs | build, `pnpm test`, schemas; AISDLC-727 | 512 s, 8 of 34 | KEEP, absorbs Coverage | no |
| `coverage` | `ai-sdlc-gate.yml:214` | code PRs | floors plus 90% patch; AISDLC-726, 376 | 500 s, 6 of 34 | FOLD into `build-test` | no |
| `integration` | `ai-sdlc-gate.yml:253` | code PRs, same-repo | cross-package merge-skew | 115 s, 2 of 34 | KEEP | no |
| `backlog-drift` | `ai-sdlc-gate.yml` | every PR | drift | 25 s | KEEP | no |
| `first-run-smoke` | `ai-sdlc-gate.yml:344` | path filter (broad) | fresh install; AISDLC-771 | 54 s, 2 of 31 | SIMPLIFY (D6) | no (decided) |
| `test-python` | `ai-sdlc-gate.yml` | `sdk-python/**`, `conformance/**` | Python SDK | 22 s per version | KEEP | no |
| `test-go` | `ai-sdlc-gate.yml` | `sdk-go/**` | Go SDK | 96 s | KEEP | no |
| `attestation-gate` | `ai-sdlc-gate.yml` | code PRs | attestation valid; AISDLC-388 | 4 s | KEEP, absorbs `verify-attestation.yml` | no |
| `dependency-review-gate` | `ai-sdlc-gate.yml` | deps PRs | dependency additions; AISDLC-712.1 | 9 s | KEEP | no |
| `dor-readiness-gate` | `ai-sdlc-gate.yml` | task-file PRs | DoR; AISDLC-588, 591 | 4 s | KEEP, absorbs `dor-ingress.yml` PR half | no |
| `independence-policy-gate` | `ai-sdlc-gate.yml` | code PRs | reviewer independence; AISDLC-591 | 8 s | KEEP | no |

### 8.3 Local hooks (C)

| Item | file:line | Runs when | Protects / origin | Cost | Verdict | Loosens |
|---|---|---|---|---|---|---|
| attestation-only short-circuit | `.husky/pre-commit:1` | commit | skips tsc for envelope commits; AISDLC-371 | removes cost | KEEP | no |
| `check-backlog-ascii.sh` | `.husky/pre-commit:12` | commit | ASCII task filenames; AISDLC-92 | instant | KEEP | no |
| `lint-staged` | `.husky/pre-commit:13`, `package.json` | commit | prettier, eslint on staged; 2026-03-05 | seconds | KEEP | no |
| `typecheck-workspace.mjs` | `.husky/pre-commit:15` | every commit | whole-workspace tsc; AISDLC-687 | slowest local step, fails in fresh worktrees | MOVE to pre-push (D11) | yes (decided) |
| commitlint | `.husky/commit-msg:1` | commit | conventional commits for release-please | instant | KEEP | no |
| `post-rewrite` | `.husky/post-rewrite:1` | rebase | ff parent `main`; AISDLC-137, 708 | returns early when the parent has `main` checked out, the required state | DELETE | no |
| `check-substrate-contract.mjs` | `.husky/pre-push` | push | RFC-0028 type registry; AISDLC-453 | <5 s; no-op, `substrate-contracts/` does not exist in this repo | KEEP (adopter value) | no |
| `check-skip-ci-marker.sh` | `.husky/pre-push` | push | skip-ci tokens disable all workflows; AISDLC-88 | instant | KEEP | no |
| `check-dark-code-on-push.sh` | `.husky/pre-push` | push | unwired modules; AISDLC-687, 552 | static scan; duplicates CI `dark-code:check` | KEEP (early feedback) | no |
| `check-knowledge-scope.sh`, `check-pr-body-protected.sh` | `.husky/pre-push` | push | protected knowledge; AISDLC-773 (2026-10-12) | scan; duplicates CI `knowledge:check` | KEEP | no |
| `squash-attestation-chores.sh` | `.husky/pre-push` | push | squash stacked sign commits; AISDLC-369 | git only | FOLD into `pre-push-fixups.sh` (D9) | no |
| `check-changelog-edit.sh` | `.husky/pre-push` | push | warn on CHANGELOG edits; AISDLC-401 | instant, exits 0 | DELETE (D10) | yes (decided) |
| `check-followups-on-push.sh` | `.husky/pre-push` | push | follow-ups tracked; RFC-0049 9.5, AISDLC-645 | git only | KEEP | no |
| `pre-push-fixups.sh` | `.husky/pre-push` | push | ordered task-move then sign; AISDLC-386 | per sub-hook | KEEP (the single orchestrator) | no |
| `check-task-moved.sh` direct call | `.husky/pre-push` | push | duplicate of the above; AISDLC-220 | no-op | DELETE the direct call (D9) | no (the gate still runs, once) |
| `check-attestation-sign.sh` direct call | `.husky/pre-push` | push | duplicate of the above; AISDLC-133 | verifier run | DELETE the direct call (D9) | no (the gate still runs, once) |

### 8.4 `pnpm test` meta checks and root scripts (D)

| Item | file:line | Runs when | Protects / origin | Cost | Verdict | Loosens |
|---|---|---|---|---|---|---|
| `pnpm -r test` | `package.json` `test` | CI `build-test`, main-health | package suites | the long pole (8 min) | KEEP; shard | no |
| `test:gates` (`run-gate-tests.mjs`, 123 files) | `scripts/run-gate-tests.mjs:1` | in `pnpm test` | all `node --test` gate suites; AISDLC-805 | ~24 s | KEEP | no |
| `rfc:check` | `scripts/check-rfc-docs.mjs` | in `pnpm test` | RFC docs drift; AISDLC-69.3 | seconds | KEEP | no |
| `dark-code:check` | `scripts/check-dark-code.mjs` | in `pnpm test` | unwired modules; AISDLC-552 | seconds | KEEP | no |
| `knowledge:check` | `scripts/check-knowledge-scope.sh` | in `pnpm test` | knowledge scope; AISDLC-773 | seconds | KEEP | no |
| `sync:plugin-runtime-deps:check` | `scripts/sync-plugin-runtime-deps.mjs` | in `pnpm test` | plugin deps in sync; AISDLC-574 | seconds | KEEP | no |
| `lint` clock discipline | `scripts/check-clock-discipline.mjs` | in `pnpm lint` | no clock-dependent tests; AISDLC-769 | seconds | KEEP | no |
| `lint:publishable` | `package.json:20` | never called by CI or `test` | publishConfig present; AISDLC-97 | unwired | SIMPLIFY: wire into `pnpm test` or delete the script and the CLAUDE.md pointer | no |
| `validate-schemas` | `ai-sdlc-gate.yml` `build-test` | code PRs | schema validity | seconds | KEEP | no |
| agent-role `blockedActions`/`blockedPaths` | `.ai-sdlc/agent-role.yaml:45-64` | every tool call | trust-chain hard rules | n/a | KEEP; fold pairs (D13) | no |

## 9. Verdicts, grouped

### DELETE
- `isolated-review.yml` (D1): 0 minutes, 949 of 950 skipped, never a success. Loosens: yes, already decided.
- `ai-sdlc-fix-ci.yml` (D15): 999 of 1000 skipped. Loosens: yes, already decided.
- `auto-rearm-on-dequeue.yml` (D5): 80 runner-minutes, 3,062 wall minutes, 873 runs for an event that cannot occur. Loosens: no.
- `merge-queue-passthrough.yml`: no run since 2026-05-23. Loosens: no.
- Six idle issue-label workflows (`ai-sdlc.yml`, `ai-sdlc-admit/route/triage/sa-feedback/slack-issue.yml`): 0 runs in 7 days. Loosens: no (capability, not a gate; decision 9).
- `.husky/post-rewrite`: cannot act in the required Pattern C state. Loosens: no.
- `check-changelog-edit.sh` (D10): warn-only. Loosens: yes, already decided.
- Direct `check-task-moved.sh` and `check-attestation-sign.sh` calls in `.husky/pre-push` (D9). Loosens: no (each gate still runs once).
- `Backlog Drift` as a separate required context (D7). Loosens: yes, already decided.

### MOVE to nightly or main only
- `typecheck-workspace.mjs` from pre-commit to pre-push (D11). Loosens: yes, already decided.
- `scorecard.yml` from every main push to the weekly cron it already has: saves 204 runs a week. Loosens: yes (decision 11; it is a posture signal).
- `ci.yml` per-push suite into `main-health-monitor.yml`, keeping `ci.yml` nightly (F7). Loosens: no.
- `ai-sdlc-review.yml` to untrusted PRs only (AISDLC-824, open #1453). Loosens: yes (decision 5).
- `first-run-smoke` per PR to matching paths plus nightly (D6). Loosens: no (decided as a third option, not a weakening).
- CodeQL Go and Python to path-gated or weekly. Loosens: yes (decision 12).

### FOLD
- `coverage` job into `build-test` (candidate; F2): one install, one build, one test run with coverage on. About 3,000 runner-minutes a week. Loosens: no (same floors and patch gate).
- `verify-attestation.yml` into `attestation-gate` (D2). Loosens: no (decided).
- PR half of `dor-ingress.yml` into `dor-readiness-gate` (D3). Loosens: no (decided).
- `squash-attestation-chores.sh` into `pre-push-fixups.sh` (D9).
- Paired `agent-role.yaml` entries (D13).

### SIMPLIFY
- `untrusted-pr-gate.yml`: add `concurrency: group: untrusted-${{ pr }}, cancel-in-progress: true`, move the race-guard failure to a neutral conclusion, fork-only (AISDLC-799, open #1389). Removes 336 false failures.
- `auto-enable-auto-merge.yml`: only `opened`, `reopened`, `ready_for_review`; drop `check_suite` and `status` (651 of 1000 runs).
- `require-issue-link.yml`: external PRs only; 7 event types reduced to 3.
- `ai-sdlc-review.yml` (D4) as an interim step if AISDLC-824 is not taken.
- CLAUDE.md trim (D12 remainder) and wiring or removing `lint:publishable`.
- Shard the single `pnpm -r test` run (the only change that shortens the 13 minute critical path).
- Concurrency group with `cancel-in-progress` on `verify-attestation.yml`, `dor-ingress.yml`, `ai-sdlc-review.yml`, `ci.yml` (cancel rates 18 to 72 percent show runs are already being superseded, but only some of them cancel their predecessors).

### KEEP
`ai-sdlc-gate.yml` (rollup, `detect`, `lint`, `integration`, `backlog-drift`, SDK jobs, `attestation-gate`, `dependency-review-gate`, `dor-readiness-gate`, `independence-policy-gate`), `main-health-monitor.yml`, `release.yml`, `rfc-lifecycle-check.yml`, `flaky-tests.yml`, `trusted-reviewers-drift.yml`, `consumer-verify-attestation.yml`, Dependabot, the glob gate runner and every static meta check, commit-msg, lint-staged, `check-backlog-ascii.sh`, `check-skip-ci-marker.sh`, `check-dark-code-on-push.sh`, `check-knowledge-scope.sh`, `check-followups-on-push.sh`, `check-substrate-contract.mjs`, `pre-push-fixups.sh`.

## 10. Proposed task breakdown (list only; no task files created)

Each task opens its Fix with a "Five-step review (requirements first)" paragraph. Velocity impact for every task below: positive.

- **T1. Implement the 13 undone DEC-0095..0109 decisions as one tracked batch** (D1, D2, D3, D4, D5, D6, D7, D9, D10, D11, D13, D14 follow-up, D15), one PR per workflow cluster below. Five-step: requirement questioned, "decided means done" had no owner (decision loop, not CI); delete first (D1, D5, D10, D15); simplify (D2, D3, D9); accelerate and automate with a check that fails when a recorded `governance:gates` decision has no merged change after 7 days.
- **T2. Gate workflow: fold Coverage into Build & Test, shard tests, narrow first-run-smoke paths** (`ai-sdlc-gate.yml`, D6, F2). Requirement: coverage floors and patch gate stay (AISDLC-726); what is deleted is the second install, build and test run. Accelerate: shard.
- **T3. Attestation and DoR workflow cluster** (`verify-attestation.yml` into `attestation-gate`, `dor-ingress.yml` PR half, D2 and D3). Five-step: one verifier run and one DoR evaluation per PR; docs-only skip as a job-level `if`.
- **T4. Review and trust workflow cluster** (`ai-sdlc-review.yml` trusted-PR exemption AISDLC-824, D4; `untrusted-pr-gate.yml` concurrency and fork-only AISDLC-799; `require-issue-link.yml` external only). Five-step: stop running trust machinery on trusted PRs; delete the self-cancelling trigger leg; no failure status for a superseded run.
- **T5. Arming and queue-era cleanup** (`auto-enable-auto-merge.yml` trigger reduction, delete `auto-rearm-on-dequeue.yml` with a rollback line in `merge-without-queue.md`, delete `merge-queue-passthrough.yml`, drop dead `merge_group` legs from `ai-sdlc-review.yml`, `rfc-lifecycle-check.yml`, `ci.yml`).
- **T6. Dead workflow sweep** (`isolated-review.yml`, `ai-sdlc-fix-ci.yml`, the six idle issue-label workflows). Requirement named: RFC-0047 Phase 4, the 2026-02 dogfood pipeline.
- **T7. Main-push cluster** (`ci.yml` push leg into `main-health-monitor.yml`, `scorecard.yml` weekly only, concurrency on `release.yml` is left as is).
- **T8. Hook cluster** (D9, D10, D11, delete `post-rewrite`, wire or drop `lint:publishable`, D13).
- **T9. CodeQL scope** (advanced setup with path-gated Go and Python, or weekly Go; decision 12 first).
- **T10. Branch protection** (D7: `Backlog Drift` out of required contexts; apply with `scripts/sync-dor-branch-protection.sh`; an operator action).
- **T11. Landing, not CI** (F1): already filed as AISDLC-816, 823, 829; this audit adds the open-PR evidence (section 4, F1) and nothing else, per the scope rules.
- **T12. CLAUDE.md remainder of D12** (fold into AISDLC-742 #1248 rather than a new task; it is open and red).

## 11. Decisions for the operator

Every verdict above that loosens a control. Option ids: **keep**, **delete**, **move** (or **fold**). Items 1 to 7 and 10 are already decided on 2026-10-11 (class (b) records); they are listed so the record shows they are still waiting on implementation. A decision record in the catalog on `main` is the authority for the rest; this audit is not.

1. D1 isolated-review.yml: decided **delete**. Confirm implementation under T1/T6.
2. D15 ai-sdlc-fix-ci.yml: decided **delete**. Confirm under T6.
3. D7 `Backlog Drift` as a required context: decided **delete the context** (job stays in the rollup).
4. D10 check-changelog-edit.sh: decided **delete**.
5. `ai-sdlc-review.yml` for trusted PRs (AISDLC-824, D4): options **keep** (reviewers run for all PRs) / **move** (untrusted only; trusted PRs rely on local attestation plus the `attestation-gate`). Recommended: **move**.
6. D11 typecheck-workspace.mjs: decided **move** to pre-push.
7. D6/first-run smoke narrowing: decided (third option); no new decision.
8. CodeQL Go and Python on every PR (F3): **keep** / **move** (path-gated or weekly). Recommended: **move** to path-gated.
9. Six idle issue-label workflows: **keep** / **delete**. They are not gates; deletion removes the label-triggered agent pipeline. Recommended: **delete** (0 runs for 4 weeks, `dogfood watch` is the documented API-key path).
10. `scorecard.yml` per main push: **keep** / **move** to weekly cron only. Recommended: **move**.
11. `post-rewrite` hook: **keep** / **delete**. Recommended: **delete** (cannot act under AISDLC-358).
12. `ci.yml` push leg: **keep** / **fold** into `main-health-monitor.yml` (the suite still runs once per main push). Recommended: **fold**; not a weakening, listed because it touches the post-merge safety net.
