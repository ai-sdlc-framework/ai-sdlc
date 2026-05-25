---
id: AISDLC-420
title: >-
  feat(ci): auto-rebase stale PRs on push-to-main (Option A — operator re-signs
  locally)
status: Done
assignee:
  - '@claude-opus-4.7'
created_date: '2026-05-25 00:57'
updated_date: '2026-05-24'
labels:
  - ci
  - workflows
  - attestation
  - rebase-automation
dependencies: []
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - scripts/check-attestation-sign.sh
  - scripts/verify-attestation.mjs
  - .github/workflows/auto-enable-auto-merge.yml
  - docs/operations/merge-without-queue.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When a PR merges to main, every other open PR whose branch is BEHIND main becomes `mergeStateStatus: DIRTY`. The operator currently rebases each one by hand (this session burned 4+ rebase rounds across PRs #670/671/672/673/675/676/677 for exactly this reason). Each rebase changes the work-commit SHA, which invalidates the v6 attestation envelope's `subject.digest.sha1` binding — AISDLC-419's relaxation correctly refuses the stale envelope until the operator re-signs locally.

## Scope — Option A (operator-side re-sign)

Workflow auto-rebases open DIRTY PRs on push-to-main; **does NOT re-sign** (signing key is per-machine). After the auto-rebase push, attestation goes red and the operator's next `/ai-sdlc orchestrator-tick` includes a new sweep step that walks red-attestation PRs and re-signs them in the operator's worktrees.

Option B (CI signing identity) was considered and explicitly deferred — it changes the meaning of an attestation signature and would need a follow-up RFC (no follow-up tracked at completion time; see [RFC-0042](../../spec/rfcs/RFC-0042-proof-of-execution-attestation.md) for the existing attestation model). This task is Option A only.

## Architecture

Two files ship together in one PR:

1. **`scripts/auto-rebase-stale-prs.mjs`** (node script, hermetically testable)
   - Reads `gh pr list --state open --json number,headRefName,mergeStateStatus` (filters to same-repo, non-draft, non-fork)
   - For each `mergeStateStatus: 'DIRTY'` or `'BEHIND'`:
     - `git fetch origin <branch>` + checkout into a temp worktree at `<TMPDIR>/aisdlc-rebase-<n>`
     - `git rebase origin/main`
     - On clean rebase: `git push --force-with-lease origin <branch>` + post a comment `auto-rebased onto main (operator must re-sign locally — run `/ai-sdlc orchestrator-tick` to sweep)`
     - On conflict: `git rebase --abort`, remove worktree, post a comment `auto-rebase aborted: conflicts in <files> — manual rebase needed`, label `needs-manual-rebase`
     - Always: cleanup temp worktree
   - Outputs `{rebased: [{pr, branch, status}], conflicted: [{pr, branch, files}], skipped: [{pr, reason}]}` JSON to stdout for the workflow + emits one-line text log per PR.
   - Pre-flight: refuse to run if `git config user.email` is unset (workflow sets it to `github-actions[bot]@users.noreply.github.com`).

2. **`scripts/auto-rebase-stale-prs.test.mjs`** (vitest)
   - Mocks `gh` CLI via `child_process.spawnSync` injection (similar to existing test patterns in `scripts/*.test.mjs`)
   - Covers: empty open PRs (no-op), single clean rebase, single conflicting rebase, mixed batch, fork PR skipped, draft PR skipped, git user unset → refuses, temp worktree cleanup on failure path.

3. **`.github/workflows/auto-rebase-stale-prs.yml`** — DRAFTED IN THIS TASK BODY (see below), operator drops into place since `.github/workflows/**` is hook-blocked for dev subagents.

4. **`docs/operations/auto-rebase-stale-prs.md`** — runbook for the operator:
   - What the workflow does + when it fires
   - How re-sign-after-auto-rebase fits into the standard tick recipe
   - Failure mode: conflict-labelled PRs require manual rebase
   - Rollback: disable the workflow file (rename `.yml` → `.yml.disabled`)

## Workflow YAML (operator drops into `.github/workflows/auto-rebase-stale-prs.yml`)

```yaml
name: Auto-rebase stale PRs on push-to-main

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-rebase:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Configure git identity
        run: |
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git config user.name "github-actions[bot]"
      - name: Walk open PRs + auto-rebase
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node scripts/auto-rebase-stale-prs.mjs
```

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `scripts/auto-rebase-stale-prs.mjs` exists with the contract described in §Architecture
2. `scripts/auto-rebase-stale-prs.test.mjs` covers the 8 cases listed (≥80% patch coverage)
3. Workflow YAML draft is included verbatim in `docs/operations/auto-rebase-stale-prs.md` so the operator can drop it into `.github/workflows/` in a follow-up commit on the same PR
4. Runbook covers: trigger, re-sign-recipe, conflict-failure-mode, rollback
5. Smoke-test instructions: how to dry-run the script locally against the real `gh` API (e.g. `node scripts/auto-rebase-stale-prs.mjs --dry-run`)
6. No edits to `.github/workflows/**` or `.ai-sdlc/**` in the dev's PR diff (hook will block; YAML is documented for operator placement)
7. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## Out of scope (explicit)

- Re-sign automation (Option B) — separate RFC needed
- Conflict resolution beyond aborting + labelling (the existing rebase-resolver agent handles that for explicit invocations)
- Workflow-driven Slack/digest notifications (existing `events.jsonl` writer suffices for the first iteration)

## References

- AISDLC-419 (attestation-only-descendant relaxation that catches the stale envelopes)
- AISDLC-356 (auto-rearm-auto-merge after force-push — sister automation)
- AISDLC-400 (merge-queue removal — context for why DIRTY now matters)
- This session's PR #660/#675/#676/#677 manual-rebase incidents
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 scripts/auto-rebase-stale-prs.mjs exists with contract described in description (gh pr list walker, per-PR worktree rebase, clean-vs-conflict branching, structured JSON + text output)
- [x] #2 scripts/auto-rebase-stale-prs.test.mjs covers 8 cases: empty PRs, single clean, single conflict, mixed batch, fork-PR skip, draft-PR skip, git-user-unset refusal, temp-worktree cleanup on failure
- [x] #3 Workflow YAML draft included verbatim in docs/operations/auto-rebase-stale-prs.md so operator drops it into .github/workflows/ in a follow-up commit on the same PR (dev does NOT edit .github/workflows/ directly)
- [x] #4 docs/operations/auto-rebase-stale-prs.md runbook covers: trigger semantics, re-sign-after-auto-rebase recipe, conflict-failure-mode + needs-manual-rebase label, rollback (rename .yml → .yml.disabled)
- [x] #5 Smoke-test instructions present: --dry-run flag + example local invocation against a real org/repo
- [x] #6 Patch coverage ≥80% on both .mjs files
- [x] #7 pnpm build && pnpm test && pnpm lint && pnpm format:check clean
<!-- AC:END -->
