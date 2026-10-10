# Merge Without Queue — Operator Runbook

**Status:** Active (since AISDLC-400, 2026-05-23)
**Audience:** AI-SDLC operators managing the main branch merge flow.
**Prerequisite:** AISDLC-398 (content-addressed envelopes, `contentHashV4` / headBlobSha-based) must be merged before this runbook applies — the queue-drop is only safe because envelopes are now base-independent.

---

## TL;DR

The GitHub merge queue is **disabled**. PRs merge directly via GitHub's auto-merge (squash) once `ai-sdlc/pr-ready` and `Backlog Drift` required checks pass. No serialization, no update-branch CI re-run, no `merge_group` events.

To re-enable the queue: see [Rollback procedure](#rollback-procedure) below.

---

## Why the queue was dropped (AISDLC-400)

Operator architectural review on 2026-05-23 determined the merge queue was overkill for this repo's scale:

| Queue benefit | Does this repo have the problem? |
|---|---|
| Serialized merges prevent concurrent-merge skew | No — 1-5 PRs in flight, solo operator + agents |
| Pre-merge skew testing (sibling-PR overlaps) | No — files are mostly disjoint across tasks |
| Atomic transactions (all-or-nothing CI + merge) | No — required by enterprise, not by a solo team |

| Queue cost | Felt? |
|---|---|
| 1x throughput (PRs queue behind each other) | Yes — autonomous drain is throughput-limited |
| 10-15 min update-branch CI re-run per PR | Yes — each merge triggers another full CI cycle |
| `merge_group` event complexity in workflows | Yes — 6 workflows had merge_group branches |
| v4-kick (attestation invalidation on queue rebase) | Was felt acutely; AISDLC-398 closed the gap |

**Verdict:** drop the queue, achieve equivalent safety via:
- Branch protection: require `ai-sdlc/pr-ready` + `Backlog Drift`
- Repo settings: squash-only merges (same as the queue's enforced strategy)
- AISDLC-398 content-addressed envelopes: base-independent, survive any commit-SHA change

### Why AISDLC-398 made this safe

Pre-AISDLC-398, the attestation envelope was `contentHashV4` — a SHA-256 of `{path, baseBlobSha}` entries, making it dependent on the PR's base commit. When the merge queue rebased the PR onto a new tip (because a sibling PR merged first), `baseBlobSha` changed, the envelope invalidated, and the queue ejected the PR. The operator had to manually rebase + re-sign (the "v4-kick").

AISDLC-398 changed the content hash to be base-independent (`headBlobSha` only). Envelopes now survive any commit-SHA change, including a force-push rebase. Dropping the queue is safe: there's no "queue rebase" to invalidate the envelope anymore.

---

## Current merge flow

```
1. Developer pushes branch + opens DRAFT PR
2. /ai-sdlc execute: reviewers run, attestation signed, draft flipped → ready
3. auto-enable-auto-merge.yml fires on ready_for_review
   → gh pr merge --auto --squash <PR>
4. GitHub waits for required checks:
   → ai-sdlc-gate.yml: Backlog Drift passes (backlog references valid)
   → ai-sdlc-gate.yml: ai-sdlc/pr-ready passes (lint + build + test + coverage + integration)
5. Both checks pass → GitHub squash-merges PR into main automatically
6. Nothing rebases the other open PRs. A PR is rebased only when it conflicts,
   by its executor or the conflict-resolver agent (AISDLC-727 / DEC-0056).
```

CI runs once per pull request (AISDLC-727): `ai-sdlc-gate.yml` is the only workflow that runs the suite on `pull_request` events. `ci.yml` runs on pushes to `main` and the nightly schedule only (the post-merge full run). The jobs that used to exist only in `ci.yml` (`Backlog Drift`, first-run smoke, Python SDK, Go SDK) moved into the gate workflow and feed `ai-sdlc/pr-ready`; `Backlog Drift` keeps its job name because it is a required context.

Total wall-clock time: ~5-10 min (CI time) vs ~15-25 min with the queue (CI + queue probe + update-branch CI re-run).

---

## Open PR handling (AISDLC-727 / DEC-0056)

`auto-rebase-open-prs.yml` was deleted. It rebased every other open PR after every merge to `main`; each rebase restarted CI, cancelled runs in flight, disarmed auto-merge and invalidated the attestation envelope's head binding (a 50-PR sample showed ~37 workflow runs per PR, 343 cancelled runs and auto-merge toggled about 350 times). The up-to-date requirement on `main` is off (`strict=false`, DEC-0010), so those rebases were not needed to merge.

Current rule: a PR is rebased only when it conflicts with `main`, by its executor or the `ci-conflict-resolver` / `/ai-sdlc rebase` path. A PR that is merely BEHIND merges as-is once required checks pass. AISDLC-491 / AISDLC-448 keep the v6 attestation valid for disjoint PRs across any later rebase.

`auto-rebase-on-queue-kick.yml` was also deleted: it triggered only on `ai-sdlc/attestation` failures on `gh-readonly-queue/main/pr-*` probe SHAs, which no longer exist. `auto-rearm-on-dequeue.yml` is kept: it never rebases, and still re-arms auto-merge on `synchronize` / `ready_for_review` and on a 5-minute cron when GitHub clears the flag.

If you flip branch protection back to `strict=true`, restore the proactive rebase from git history (`git log --diff-filter=D -- .github/workflows/auto-rebase-open-prs.yml`) or rebase PRs by hand.

---

## Monitoring for merge skew

Without a queue, concurrent merges from different branches can occasionally land on main in the same CI window. For this repo (1-5 PRs in flight), the risk is low but not zero.

**What to watch:**
- `ci.yml` failures on `main` branch (the `push: branches: [main]` trigger) — these indicate a merge introduced a regression.
- PRs with overlapping file changes where the second-merged PR didn't see the first's changes in testing.

**Response to a merge skew incident:**
1. Identify which two PRs touched the same file and merged in close succession.
2. Run `git log --first-parent main -5` to see the merge order.
3. Check if the regression is in the overlap zone.
4. If skew becomes a recurring pattern (>2 incidents/month), re-enable the merge queue per the rollback procedure below.

**Expected skew frequency at this scale:** very low. Industry data suggests merge queues provide meaningful benefit at >50 PRs/day or when multiple teams frequently touch the same files. At <5 PRs/day with disjoint files, direct merge is effectively equivalent.

---

## Operator action checklist (post-AISDLC-400 merge)

Run `scripts/sync-branch-protection.sh` first (automated), then complete the UI steps:

### Step 1 — Apply branch protection (automated)
```bash
cd <repo-root>
bash scripts/sync-branch-protection.sh
```

This PATCHes required_status_checks to `[ai-sdlc/pr-ready, Backlog Drift]` with `strict: true`. Requires admin permission. Safe to re-run.

### Step 2 — Disable merge queue in branch protection (UI)
1. Go to **Settings → Branches → Edit rule for `main`**
2. Uncheck **Require merge queue** (if checked)
3. Save

### Step 3 — Set squash-only merge in repo settings (UI)
1. Go to **Settings → General → Pull requests**
2. Set **Default merge method** to **Squash merging**
3. Uncheck **Allow merge commits**
4. Uncheck **Allow rebase merging**
5. Save

These settings ensure that even if auto-merge is manually triggered without `--squash`, the repo-level default squash setting applies.

### Step 4 — Verify
Open a trivial docs PR (or use an in-flight PR) and confirm:
- `auto-enable-auto-merge.yml` fires and posts `gh pr merge --auto --squash <PR>`
- `ai-sdlc/pr-ready` appears in required checks and goes green
- `Backlog Drift` appears in required checks and goes green
- PR merges automatically as a squash commit once both checks pass

---

## Rollback procedure

If dropping the queue causes merge-skew problems, re-enable it without any code revert:

### GitHub UI path (fastest)
1. **Settings → Branches → Edit rule for `main`**
2. Check **Require merge queue**
3. Set queue strategy: **Squash** (to keep linear history)
4. Save

### Code path (complement to UI)
After re-enabling the queue via UI, restore the `merge_group` triggers in:
- `.github/workflows/verify-attestation.yml` — add back the `merge_group: types: [checks_requested]` block
- `.github/workflows/ai-sdlc-review.yml` — add back the `merge_group: types: [checks_requested]` block
- `.github/workflows/ai-sdlc-gate.yml` — add back `merge_group: types: [checks_requested]`
- `.github/workflows/auto-enable-auto-merge.yml` — remove `--squash` flag (the queue enforces its own strategy)

Use `git log --oneline -- .github/workflows/` to find the AISDLC-400 commit and cherry-pick the reverse diff if needed.

**Note:** The `auto-rebase-on-queue-kick.yml` workflow (deleted by AISDLC-727) would need to be restored from git history for queue-kick recovery automation.

---

## When to re-enable the queue

Re-enable the queue if **any** of these become true:
- Concurrent merges are causing `main` CI failures more than twice per week
- Multiple team members (not just the operator) are independently merging PRs
- PR volume exceeds 30/day (queue's throughput cost is offset by its safety gain at that scale)
- A security or compliance requirement mandates serialized merges

At the current scale (1 operator, 1-5 AI agents, <10 PRs/day), direct merge remains the correct choice.

---

## References

- AISDLC-400 — task that dropped the queue
- AISDLC-398 — content-addressed envelopes (prerequisite that made this safe)
- AISDLC-399 — conditional update-branch (superseded by AISDLC-400)
- AISDLC-491 — patch-scoped verifier / rebase-invariant v6 attestation for disjoint PRs
- AISDLC-495 / DEC-0010 — strict-false guard in auto-rebase-open-prs.yml (workflow since deleted)
- AISDLC-727 / DEC-0056 — one CI run per PR; auto-rebase workflows retired
- `.github/workflows/auto-enable-auto-merge.yml` — arms auto-merge (squash) on PR open
- `scripts/sync-branch-protection.sh` — idempotent branch protection sync script
- `docs/operations/quality-gate.md` — `ai-sdlc/pr-ready` rollup documentation
