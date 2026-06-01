---
id: AISDLC-495
title: >-
  stop auto-rearm-auto-merge from rebasing open PRs onto main under strict-false
  (DEC-0010 follow-up)
status: To Do
assignee: []
created_date: '2026-06-01 22:34'
updated_date: '2026-06-01 22:38'
labels:
  - ci
  - attestation
  - branch-protection
  - dec-0010
  - operator-owned
dependencies: []
references:
  - spec/rfcs/RFC-0042-attestation-merkle-transcript.md
  - .github/workflows/auto-rebase-open-prs.yml
  - .github/workflows/auto-rebase-on-queue-kick.yml
  - .github/workflows/auto-rearm-on-dequeue.yml
  - .github/workflows/auto-enable-auto-merge.yml
  - docs/operations/merge-without-queue.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

DEC-0010 (resolved 2026-06-01, `strict-false`) dropped the require-branch-up-to-date constraint on `main` branch protection so disjoint PRs can merge concurrently without the O(N²) rebase + re-sign churn. The decision's premise: AISDLC-491 made v6 attestation rebase-invariant for *disjoint* PRs (patch-scoped verifier), so removing the *forced* rebase eliminates the per-main-landing re-sign churn.

**The churn was only partially eliminated.** Branch protection no longer *requires* up-to-date, but the `.github/workflows/auto-rearm-auto-merge.yml` workflow (the "Auto-rearm auto-merge after merge-queue dequeue" job) still **proactively rebases open PRs onto `main`** whenever another PR lands. Observed live on 2026-06-01: PR #824 (AISDLC-465) merged → main advanced to `c8f449a` → the workflow rebased open PR #831 (`chore/schema-id-io-domain`) onto it, rewriting its commits (`a2ed86b`/`e6e1a60` → `07da8df`/`e4bcc6f`). The rebase re-staled #831's v6 attestation: the envelope was signed against a tree *without* #824's now-merged changes, so the AISDLC-448 tree-equivalence-modulo-attestation relaxation correctly rejected it (`Attestation gate (code PRs)` → FAILURE), forcing a manual re-sign + force-push to land #831.

This is the exact per-main-landing re-sign churn DEC-0010 + AISDLC-491 were meant to remove. The remaining trigger is the workflow's proactive rebase, not branch protection.

## Goal

Under `strict-false`, the auto-rearm/auto-merge automation should NOT rebase an open PR onto `main` just because another (disjoint) PR landed. A PR whose attestation is valid against its own merge-base should merge as-is; only a genuine merge conflict (overlapping files) should require a rebase. This makes the AISDLC-491 rebase-invariance actually pay off.

## Proposed approach (pick during implementation)

- Gate the rebase step in `auto-rearm-auto-merge.yml` on branch-protection `strict` being `true` (skip the rebase entirely when `strict=false`), OR
- Only rebase when GitHub reports the PR as actually behind+conflicting (`mergeStateStatus` requiring it), not on every main landing, OR
- Remove the proactive rebase and rely on direct merge + the AISDLC-406 main-health-monitor backstop (the trunk-based posture DEC-0010 chose).

Confirm the interaction with `auto-enable-auto-merge.yml` (squash) and the no-merge-queue model (AISDLC-400) so the two automations don't fight.

## Acceptance Criteria
<!-- AC:BEGIN -->
(see AC list)

- [ ] #1 auto-rearm-auto-merge.yml does NOT rebase an open PR onto main when branch protection strict=false and the PR has no overlapping-file conflict (verified by a scenario: land PR A, confirm disjoint open PR B's head SHA and attestation are unchanged and B remains mergeable)
- [ ] #2 A PR with a valid v6 attestation against its own merge-base merges without a forced re-sign after an unrelated PR lands
- [ ] #3 The change composes with auto-enable-auto-merge.yml (squash) and the no-merge-queue direct-merge model — no fighting automations, documented in docs/operations/merge-without-queue.md
- [ ] #4 Workflow YAML tests (.github/workflows/__tests__/) cover the strict-false no-rebase path
- [ ] #5 A genuine overlapping-file conflict still triggers the expected rebase/re-sign path (regression guard)
<!-- AC:END -->

## Notes
- This is a `.github/workflows/**` edit — operator-owned (agents cannot modify CI workflows).
- Related: DEC-0010 (branch-protection posture), AISDLC-491 (patch-scoped verifier / rebase-invariant attestation), AISDLC-487 (merge starvation), AISDLC-400 (merge queue dropped), AISDLC-406 (main-health-monitor backstop). Memory: per-main-landing attestation re-sign churn.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CORRECTED FILE: the proactive rebaser is `.github/workflows/auto-rebase-open-prs.yml` ("Auto-rebase open PRs on main push", AISDLC-138) — NOT auto-rearm-auto-merge.yml (which doesn't exist). It triggers `on: push: branches:[main]` and runs `gh pr update-branch --rebase <PR>` against EVERY open non-draft same-repo PR, then re-arms auto-merge with `--auto --rebase`. This is what rebased #831 onto main after #824 merged (2026-06-01), re-staling its v6 attestation.

RECOMMENDED FIX (option A — minimal, reversible): short-circuit the job under strict-false. Insert at the top of the `run:` block (after `set -euo pipefail`), before the PR listing:

```bash
# AISDLC-495 / DEC-0010: under strict-false branch protection, proactively
# rebasing open PRs onto main is unnecessary (AISDLC-491 made v6 attestation
# rebase-invariant for disjoint PRs) and actively harmful — the rebase re-stales
# the attestation (envelope signed against a tree without the just-merged
# changes). Skip unless branch protection requires up-to-date.
STRICT=$(gh api "repos/$REPO/branches/main/protection/required_status_checks" --jq '.strict' 2>/dev/null || echo "false")
if [ "$STRICT" != "true" ]; then
  echo "branch protection strict=$STRICT — skipping proactive rebase (AISDLC-495 / DEC-0010 trunk-based posture)."
  exit 0
fi
```

Also audit `auto-rebase-on-queue-kick.yml` and `auto-rearm-on-dequeue.yml` for the same proactive-rebase behavior (they are merge-queue-event triggered; the queue was dropped in AISDLC-400 so they may be dormant, but confirm they can't rebase under the no-queue model). The genuine-conflict path (`gh pr update-branch` failing on overlapping files) is preserved — only the unconditional always-current rebase is removed.

OPERATOR-OWNED: editing .github/workflows/** (incl. the __tests__/ alongside) is blocked for agents by the PreToolUse hook. The one-file YAML edit must be applied by the operator directly; an agent can only assist with the docs/operations/merge-without-queue.md update (outside the blocked path).
<!-- SECTION:NOTES:END -->
