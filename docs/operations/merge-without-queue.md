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
   → ci.yml: Backlog Drift passes (backlog references valid)
   → ai-sdlc-gate.yml: ai-sdlc/pr-ready passes (lint + build + test + coverage + integration)
5. Both checks pass → GitHub squash-merges PR into main automatically
6. auto-rebase-open-prs.yml fires on main push → reads branch protection strict flag
   → strict=false (current DEC-0010 posture): exits 0, open PRs NOT proactively rebased
   → strict=true (reverted posture): rebases other open PRs as before
```

Total wall-clock time: ~5-10 min (CI time) vs ~15-25 min with the queue (CI + queue probe + update-branch CI re-run).

---

## Open PR handling under strict-false (AISDLC-495 / DEC-0010)

### What changed

`auto-rebase-open-prs.yml` fires on every push to `main`. Before AISDLC-495, it would unconditionally call `gh pr update-branch --rebase` on every open non-draft same-repo PR. This caused a **per-main-landing re-sign churn** under the DEC-0010 `strict=false` branch protection posture:

1. PR A merges → main advances
2. `auto-rebase-open-prs.yml` fires → rebases open PR B onto the new main
3. Rebase rewrites B's commits (new SHAs)
4. B's v6 attestation envelope was signed against a tree **without** A's changes
5. The AISDLC-448 tree-equivalence verifier correctly rejects the stale envelope
6. B's `Attestation gate (code PRs)` fails → operator must manually re-sign + force-push

This is the exact per-main-landing re-sign churn that DEC-0010 + AISDLC-491 were meant to eliminate. The proactive rebase was the remaining trigger.

### The fix (AISDLC-495)

The workflow now reads the branch protection `strict` flag before rebasing:

```bash
STRICT=$(gh api "repos/$REPO/branches/main/protection/required_status_checks" --jq '.strict' 2>/dev/null || echo "false")
if [ "$STRICT" != "true" ]; then
  echo "branch protection strict=$STRICT — skipping proactive rebase (AISDLC-495 / DEC-0010 trunk-based posture)."
  exit 0
fi
```

Under `strict=false` (the current posture per DEC-0010): the workflow exits 0 immediately. Open PRs are **not** rebased on every main landing. A PR whose attestation is valid against its own merge-base merges as-is once required checks pass — no forced re-sign.

Under `strict=true` (reverted posture): the guard passes, and the full rebase path runs as before — including the genuine-conflict path (`gh pr update-branch --rebase` failing on overlapping files, which requires operator intervention).

### Why this is safe

AISDLC-491 made v6 attestation rebase-invariant for **disjoint** PRs. The verifier's tree-equivalence-modulo-attestation check (AISDLC-448) accepts envelopes where the source tree at `subject.sha1` and at HEAD are byte-identical modulo attestation paths. A disjoint rebase (non-overlapping files) produces exactly this: the source tree is unchanged, only the commit graph changes. The Merkle root + trusted-key signature still gate acceptance, so a rebase that resolves a real semantic conflict (i.e. changes any source byte) correctly fails verification.

For **overlapping** PRs (same file modified by two branches), a genuine merge conflict arises at `gh pr merge` time. GitHub surfaces this as a "can't merge" state on the PR — the operator must rebase manually and re-sign. The `auto-rebase-open-prs.yml` genuine-conflict path (the inner loop with `gh pr update-branch --rebase` per PR) is preserved intact for the `strict=true` revert scenario.

### How to revert (strict=true re-engages proactive rebase)

If you flip branch protection back to `strict=true` (require up-to-date before merge):

```bash
gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
  -F 'contexts[]=Backlog Drift' \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'strict=true'
```

The next push to main will trigger `auto-rebase-open-prs.yml`, the guard will read `strict=true`, and the proactive rebase path will re-engage automatically. No workflow edits needed.

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

**Note:** The `auto-rebase-on-queue-kick.yml` workflow (now inert) would need to be restored for queue-kick recovery automation.

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
- AISDLC-495 / DEC-0010 — strict-false guard in auto-rebase-open-prs.yml (this change)
- `.github/workflows/auto-enable-auto-merge.yml` — arms auto-merge (squash) on PR open
- `.github/workflows/auto-rebase-open-prs.yml` — proactive rebase (now gated on strict=true)
- `scripts/sync-branch-protection.sh` — idempotent branch protection sync script
- `docs/operations/quality-gate.md` — `ai-sdlc/pr-ready` rollup documentation
