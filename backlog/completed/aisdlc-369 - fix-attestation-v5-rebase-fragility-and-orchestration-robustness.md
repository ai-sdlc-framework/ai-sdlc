---
id: AISDLC-369
title: 'fix(attestation+orchestration): v5 rebase-survives-sibling-merges + auto-rearm + pre-push helpers'
status: Done
assignee: []
created_date: '2026-05-19'
labels:
  - attestation
  - merge-queue
  - critical
  - hotfix
dependencies: []
priority: critical
references:
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
  - .github/workflows/auto-enable-auto-merge.yml
  - scripts/check-orchestrator-state.sh
---

## Problem

Operator session 2026-05-19: shipping 11 PRs required ~30 re-sign cycles because the v5 attestation envelope DOES NOT survive sibling-PR merges in practice. Each time `origin/main` advances:

1. CI's `verify-attestation` computes v5 hash → returns null (signedMergeBase not reachable, OR diff includes additional files from the sibling merge)
2. Falls through to v4 → v4 mismatch (base moved)
3. Posts `ai-sdlc/attestation: failure - contentHashV4 mismatch`
4. PR becomes BLOCKED → queue drops it → auto-merge flag cleared
5. Operator must: drop chore-sign, rebase, re-sign, push, re-arm `gh pr merge --auto`

For 8 PRs through the queue serially, that's **~32 manual re-sign cycles** at ~3min each = **96 min of pure re-sign overhead**, on top of CI cycle time.

V5 was designed to fix this by binding to a frozen `signedMergeBase`, but the design assumed the verifier could reproduce the diff between `<signedMergeBase>..HEAD` identically locally vs. CI. In practice this is breaking on every queue rebase.

Plus several queue/orchestration robustness issues compounded the pain.

## Multi-part fix (single PR)

### A. V5 envelope rebase fragility — investigate + fix

`scripts/verify-attestation.mjs` and `ai-sdlc-plugin/scripts/sign-attestation.mjs` both implement `computeContentHashV5` + `collectChangedFileEntriesForV5`. The contract is:

- **At sign time**: compute `git merge-base <baseRef> HEAD` once → embed as `signedMergeBase` in envelope
- **At verify time**: read `signedMergeBase` from envelope → diff `<signedMergeBase>..<HEAD>` → hash those files
- Result MUST match envelope's `contentHashV5` regardless of where `origin/main` has moved

In practice CI reports `contentHashV4 mismatch` whenever the queue rebases the PR's branch onto a new `main` tip, meaning **v5 returned null** (fell through to v4). Hypothesis: CI's shallow clone doesn't have `signedMergeBase` reachable, OR the diff produces a different file set on rebased PR HEAD than at sign time.

Tasks:

1. Add a `cli-verify-attestation-debug` command that prints v5 vs v4 vs v3 evaluation trace for a given PR + HEAD. Run against any open PR with `ai-sdlc/attestation: failure` to identify which step falls through.
2. If `signedMergeBase` unreachable in CI: workflow needs `fetch-depth: 0` or explicit `git fetch <signedMergeBase>` step in `verify-attestation.yml`.
3. If diff produces different files: the algorithm needs to canonicalize file set (sort + dedup) consistently OR scope the diff to only files the PR author touched via three-way merge-base detection.

### B. Auto-rearm on merge_group dequeue

`auto-enable-auto-merge.yml` only fires on `pull_request opened` event. When the queue dequeues a PR (UNMERGEABLE), the auto-merge flag is cleared and operator must manually re-arm.

Add a new auto-rearm workflow (target path under `.github/workflows/`):

```yaml
on:
  pull_request:
    types: [ready_for_review, synchronize]
  # GH doesn't expose a 'dequeued' event, so poll via a 5min cron
  schedule:
    - cron: '*/5 * * * *'
```

Job logic: for each open PR with `mergeable_state == 'clean'` and `auto_merge == null`, set `--auto`. Idempotent.

### C. Pre-push helper: squash stacked chore-sign commits

Re-sign cycles produce stacked `chore: sign v5 attestation` commits because the operator forgets `git reset --hard HEAD~1` first. Add a new helper script under `scripts/`:

```bash
# When HEAD..HEAD~2 are both "chore: sign v5", squash to one
git log --oneline -2 | grep -c 'chore: sign v5' == 2 && git reset --soft HEAD~2 && git commit -C HEAD@{1}
```

Invoke from `.husky/pre-push` defensively (idempotent).

### D. Branch-name truncation defense

`gh pr list --json` returns truncated branch names in some output paths. Always resolve via `gh api repos/<owner>/<repo>/pulls/<n> --jq .head.ref` for the exact name. Document the rule in `docs/operations/merge-queue-rebase-recovery.md` + add a new regression-test helper under `scripts/`.

### E. check-orchestrator-state.sh: distinguish "behind on main" from "user-modified"

Parent repo in Pattern C should be on main. The script currently refuses to recover when working tree has tracked modifications, but "modifications" includes "behind on main with no local edits" (rename diffs from completed/ moves). Fix: detect zero `git stash --staged` diff after `git reset --hard` would land, then proceed.

## Acceptance criteria

- [ ] **V5 root cause identified**: trace command shows whether v5 fails due to unreachable signedMergeBase OR diff mismatch
- [ ] **V5 fix landed**: workflow `verify-attestation.yml` fetches signedMergeBase if not reachable; algorithm is verified-by-test to survive sibling merges of non-overlapping files
- [ ] **Test for the v5 fix**: integration test that simulates the rebase scenario — a signed PR's verify-attestation still passes against the original signedMergeBase even when main has advanced via a non-overlapping merge
- [ ] **Auto-rearm workflow** lands and runs every 5min; tested by manually dequeueing a PR and watching it re-arm
- [ ] **Squash-chore-sign helper** lands; manual re-sign cycles consolidate to one chore commit
- [ ] **Branch-name resolution rule** documented + regression test
- [ ] **Orchestrator-state.sh** correctly recovers parent when only diff is "behind on main"

## Out of scope

- Replacing v5 with v6 (don't redesign — diagnose first)
- Auto-rebase + auto-resign daemon (out of scope — separate orchestration work)
- Operator UX to surface re-sign cycles in TUI (separate)

## Source

Operator session 2026-05-19: ~30 manual re-sign cycles to ship 11 PRs because v5 doesn't survive concurrent merges as designed. "We need consistent and predictable merges landing."
