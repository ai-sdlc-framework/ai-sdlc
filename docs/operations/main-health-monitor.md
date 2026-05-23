# Main Health Monitor — Operator Runbook

**Status:** Active (since AISDLC-406, 2026-05-23)
**Audience:** AI-SDLC operators managing the main branch health.
**Workflow:** `.github/workflows/main-health-monitor.yml`

---

## TL;DR

A GitHub Actions workflow fires on every push to `main` and runs the full test suite. If any test fails, it automatically creates a GitHub issue titled `[main-health] main is RED at <commit>` assigned to `@deefactorial`. When you see this issue, use the triage steps below to bisect which PR introduced the regression.

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
2. main-health-monitor.yml triggers on push to main
3. Full test suite runs (pnpm -r test + workflow YAML tests)
4. If all green → workflow completes silently (no issue created)
5. If any failure:
   a. health-check job exits non-zero (visible as red in Actions UI)
   b. alert job fires and creates GitHub issue:
      Title: "[main-health] main is RED at <8-char-sha>"
      Assigned to: @deefactorial
      Body: commit SHA + message + link to failing CI run + triage steps
```

The issue is the primary notification mechanism. GitHub sends an email/notification to assigned users on issue creation.

---

## Relationship to other CI workflows

| Workflow | Trigger | Scope | Purpose |
|---|---|---|---|
| `ai-sdlc-gate.yml` | PR events (push/sync/ready) | Per-PR, affected packages | **Pre-merge gate** — blocks merge until green |
| `ci.yml` | PR + push to main | Per-PR: affected pkgs; push: full | General CI (build, test, lint, coverage) |
| `main-health-monitor.yml` | Push to main only | **Always full suite** | **Post-merge skew detector** — alerts when merge combination breaks main |

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

## Triage a red-main alert

When you receive a `[main-health] main is RED at <sha>` issue:

### Step 1 — Identify the failing tests

Click the **CI run** link in the issue body. Look for the `Test (full suite)` step output. The failing test names are listed there.

### Step 2 — Identify the candidate PRs

```bash
cd <repo>
git fetch origin main
git log --oneline origin/main -10
```

This shows the last 10 commits on main (squash merges, one per PR). The red commit SHA is in the issue title. Look at the commit just before it (the last green) and identify which PR(s) merged between them.

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

2. **Is it a real regression?** (feature broken, API incompatibility, etc.)
   - Fix: revert the culprit PR or push a fix PR
   - Action: `git revert <sha>` on a new branch, push PR with `fix: revert <pr-title> (main red)`

3. **Is it an infra issue?** (flaky test, timing issue, environment dependency)
   - Fix: rerun the CI, use `pnpm test:flaky` detection if available
   - Action: see `docs/operations/flaky-tests.md`

### Step 5 — Close the issue

Once main is green again (either via fix PR or confirmed false alarm):

1. Close the GitHub issue with a comment explaining what happened and what fixed it.
2. If this is the second+ time the same test/package has caused a merge-skew alert, file a follow-up task to improve test isolation in that package.

---

## When to re-enable the merge queue

The merge queue was dropped (AISDLC-400) because the cost/benefit didn't justify it at current scale. Re-enable if:

- This monitor fires more than **twice per week** on average (sustained pattern, not a spike)
- Multiple concurrent merges are regularly colliding in the same test area
- The operator is spending >1h/week triaging red-main alerts

See `docs/operations/merge-without-queue.md` — Rollback procedure.

---

## Duplicate issue prevention

The alert job checks for existing open `[main-health] main is RED` issues before creating a new one. If main is red from commit N and commit N+1 also fails (e.g. a failed fix attempt), no duplicate issue is created. The existing open issue serves as the tracking record. Add comments to it manually as you triage.

---

## References

- AISDLC-406 — this monitoring workflow
- AISDLC-400 — task that dropped the merge queue
- AISDLC-398 + AISDLC-400 + AISDLC-405 — motivating incident chain
- `.github/workflows/main-health-monitor.yml` — the workflow
- `docs/operations/merge-without-queue.md` — full merge flow + rollback
- `docs/operations/quality-gate.md` — `ai-sdlc/pr-ready` per-PR gate
