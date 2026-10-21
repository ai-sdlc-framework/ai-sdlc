# Main Health Monitor — Operator Runbook

**Status:** Active (since AISDLC-406, 2026-05-23)
**Audience:** AI-SDLC operators managing the main branch health.
**Workflow:** `.github/workflows/main-health-monitor.yml`

---

## TL;DR

A GitHub Actions workflow fires on every push to `main` and daily at 06:00 UTC, and runs the full test suite. If any test fails, the run fails and writes a step summary. It creates no issue and no label (AISDLC-929). The dispatch tick reads the run conclusion and reports `main: RED at <sha>` with the run URL as a `route-to-planner` item, once per sha; otherwise `main: green`, or `main: unknown` when the head sha has no completed run (nothing is routed).

---

## Why this exists

AISDLC-400 dropped the GitHub merge queue in favor of direct parallel merges for throughput. The expected trade-off: faster merges, lower pre-merge skew protection. The unexpected cost showed up immediately:

- **AISDLC-398** shipped content-addressed envelopes (prerequisite)
- **AISDLC-400** dropped the merge queue (direct merge, parallel CI)
- **AISDLC-405** was a test-cleanup PR that combined with the above to break `main`'s test suite, blocking 5 other open PRs from merging

Each individual PR had green CI. Their combination broke `main`. This workflow provides the reactive signal layer: when main goes red, the operator knows within minutes and can bisect.

---

## Alert flow

```
1. PR merges into main (auto-merge squash, AISDLC-400)
2. main-health-monitor.yml triggers on push to main (or the daily 06:00 UTC schedule)
3. Full test suite runs (pnpm -r test + workflow YAML tests)
4. If all green → the run succeeds and the tick reports `main: green`
5. If any failure:
   a. health-check job exits non-zero (visible as red in Actions UI) and writes the step summary
   b. the next dispatch tick (`cli-dispatch reconcile`) finds the failed run for the main head and
      reports `main: RED at <sha> <run url>` as a route-to-planner item, once per sha
```

The dispatch tick is the notification path: a red main blocks every PR's Build and Test, and dispatch acts on it. The once-per-sha record lives in `<board>/main-health.json`.

---

## Scheduled run and label behaviour (AISDLC-768)

The workflow also runs on a daily `schedule` (06:00 UTC) against the current `main` head, so a test that rots with the calendar (clock-dependent fixtures) turns red without waiting for an unrelated push. On scheduled runs `github.event.head_commit` is empty, so the workflow reads the commit subject from the checked-out head with `git log -1 --format=%s`.

No labels are created.

---

## Relationship to other CI workflows

| Workflow | Trigger | Scope | Purpose |
|---|---|---|---|
| `ai-sdlc-gate.yml` | PR events (push/sync/ready) | Per-PR, affected packages | **Pre-merge gate** — blocks merge until green |
| `ci.yml` | Nightly schedule + merge_group (no push, AISDLC-842) | Nightly first-run smoke | Scheduled smoke only |
| `main-health-monitor.yml` | Push to main + daily 06:00 UTC | **Always full suite** | **Single main-push suite** — build, tests, lint, format, schema validation, coverage, first-run smoke, workflow tests, gate scripts (incl. backlog drift), Python and Go SDK tests; alerts when a merge combination breaks main |

Key distinction: `main-health-monitor.yml` always runs the full test suite (`pnpm -r test`), not affected-package filtered. This is intentional — merge-skew failures are cross-package by definition; affected-package CI would miss them.

---

## Concurrency behavior

The workflow uses:
```yaml
concurrency:
  group: main-health-monitor
  cancel-in-progress: false
```

`cancel-in-progress: false` means each push to main gets its own complete health check run. If main is red and someone pushes a fix, BOTH runs complete: one confirming the break, one confirming the fix. This is unlike PR CI (which cancels old runs when a new push arrives — correct for PRs, wrong for post-merge health checks).

---

## Triage a red main

When the tick reports `main: RED at <sha>`:

### Step 1 — Identify the failing tests

Click the run URL in the report. Look for the `Test (full suite)` step output. The failing test names are listed there.

When `coverage=failure` is the only non-success outcome, read the `Coverage (full)` step log, not the rollup step (`Fail on test failure`): the rollup only reports the outcome, the failing test and its error are in the coverage step.

### Step 2 — Identify the candidate PRs

```bash
cd <repo>
git fetch origin main
git log --oneline origin/main -10
```

This shows the last 10 commits on main (squash merges, one per PR). The red commit SHA is in the report. Look at the commit just before it (the last green) and identify which PR(s) merged between them.

### Step 3 — Bisect the regression

If multiple PRs merged close together and it's not obvious which one caused the break:

```bash
git bisect start
git bisect bad <red-sha>          # the commit that broke main
git bisect good <last-green-sha>  # the last known-green commit

# Automated bisect (runs test suite on each candidate):
git bisect run pnpm test

# Or manual bisect (check each commit interactively):
# git bisect good / git bisect bad
```

`git bisect` will narrow down to the exact commit that introduced the regression.

### Step 4 — Assess the breakage

Once you've identified the culprit PR:

1. **Is it a test-isolation issue?** (test A passes alone, test B passes alone, A+B together flake)
   - Fix: add test isolation (independent fixtures, cleanup hooks, etc.)
   - Action: file a follow-up task for the specific package
   - Concurrency tests that flake only on slow runners: gate probes with a test-controlled barrier (per-probe deferred promises) instead of observing overlap through a wall-clock sleep (AISDLC-790; example: the executor fan-out width test).

2. **Is it a real regression?** (feature broken, API incompatibility, etc.)
   - Fix: revert the culprit PR or push a fix PR
   - Action: `git revert <sha>` on a new branch, push PR with `fix: revert <pr-title> (main red)`

3. **Is it an infra issue?** (flaky test, timing issue, environment dependency)
   - Fix: rerun the CI, use `pnpm test:flaky` detection if available
   - Action: see `docs/operations/flaky-tests.md`

### Step 5 — Follow up

Once main is green again the tick reports `main: green`; nothing needs closing. If this is the second+ time the same test/package has caused a merge-skew alert, file a follow-up task to improve test isolation in that package.

---

## When to re-enable the merge queue

The merge queue was dropped (AISDLC-400) because the cost/benefit didn't justify it at current scale. Re-enable if:

- This monitor fires more than **twice per week** on average (sustained pattern, not a spike)
- Multiple concurrent merges are regularly colliding in the same test area
- The operator is spending >1h/week triaging red-main alerts

See `docs/operations/merge-without-queue.md` — Rollback procedure.

---

## Once per sha

The tick routes a red sha once. A later red sha routes again; a stale record can never disarm the report, because there is no issue to go stale.

---

## References

- AISDLC-406 — this monitoring workflow
- AISDLC-400 — task that dropped the merge queue
- AISDLC-398 + AISDLC-400 + AISDLC-405 — motivating incident chain
- `.github/workflows/main-health-monitor.yml` — the workflow
- `docs/operations/merge-without-queue.md` — full merge flow + rollback
- `docs/operations/quality-gate.md` — `ai-sdlc/pr-ready` per-PR gate


---

## Single main-push suite (AISDLC-842)

`ci.yml` and `scorecard.yml` no longer trigger on push to main (`ci.yml` keeps its nightly schedule, `scorecard.yml` its weekly one). `main-health-monitor.yml` carries every check `ci.yml` ran on push: lint, format check, schema validation, full coverage, the first-run smoke, backlog drift, and the Python and Go SDK suites (run unfiltered), on top of the full `pnpm -r test` run. The integration tests are the `@ai-sdlc/reference` package, already inside `pnpm -r test`.
