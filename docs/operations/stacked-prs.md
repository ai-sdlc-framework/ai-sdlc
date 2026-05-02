# Stacked PRs in AI-SDLC

**Audience:** AI-SDLC Pipeline Operator + anyone reviewing the orchestrator's Step 11 (push & PR open).
**Status:** Investigation findings + workaround (AISDLC-129)
**Companion to:** [RFC-0015 Autonomous Pipeline Orchestrator §5.1](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md) (`StackedPRBaseSquashed`)

---

## TL;DR

- **`gh pr create --base <branch>` is NOT silently overridden by gh CLI.** Reproduction (gh `2.72.0`, repo `ai-sdlc-framework/ai-sdlc`, no fork) confirms the flag is honored. PR #178 was opened with `--base test/aisdlc-129-base` and the resulting PR carried `baseRefName=test/aisdlc-129-base`, not `main`.
- **The reason PR #157 (AISDLC-128) had `base=main` is that `pipeline-cli/src/steps/11-push-and-pr.ts:123` and `ai-sdlc-plugin/commands/execute.md:601` both hardcode `--base main`.** The orchestrator literally never asks gh to set a chained base. The "silent fallback" framing in the AISDLC-129 task description was a misdiagnosis — the bug is in our orchestrator, not in gh CLI.
- **Workaround for one-off stacked PRs**: use [`scripts/gh-stacked-pr.sh`](../../scripts/gh-stacked-pr.sh) which validates `--base` and `--head` exist on the remote and uses the GitHub REST API directly (`gh api -X POST /repos/.../pulls`) so the call's intent is unambiguous.
- **Out of scope for AISDLC-129**: wiring the helper into Step 11. That's a follow-up — Step 11 currently has no callers that need a chained base, because the orchestrator ships one PR per task off `main` by design. If the orchestrator ever gains a chained-PR mode, swap the hardcoded literal for the helper and this doc gets the wiring update.

---

## Reproduction

### Setup

```bash
gh --version
# gh version 2.72.0 (2025-04-30)

gh repo view ai-sdlc-framework/ai-sdlc --json defaultBranchRef,isFork,viewerDefaultMergeMethod
# {"defaultBranchRef":{"name":"main"},"isFork":false,"viewerDefaultMergeMethod":"REBASE"}
```

Two throwaway branches:

```bash
git clone https://github.com/ai-sdlc-framework/ai-sdlc.git /tmp/repro && cd /tmp/repro

git checkout -b test/aisdlc-129-base origin/main
echo marker > .marker-base && git add . && git commit -m "test base"
git push -u origin test/aisdlc-129-base

git checkout -b test/aisdlc-129-head test/aisdlc-129-base
echo marker > .marker-head && git add . && git commit -m "test head"
git push -u origin test/aisdlc-129-head
```

### The actual call

```bash
gh pr create \
  --base test/aisdlc-129-base \
  --head test/aisdlc-129-head \
  --title "test stacked PR" \
  --body "..."
# https://github.com/ai-sdlc-framework/ai-sdlc/pull/178
```

### Verification

```bash
gh pr view 178 --repo ai-sdlc-framework/ai-sdlc --json baseRefName,headRefName
# {"baseRefName":"test/aisdlc-129-base","headRefName":"test/aisdlc-129-head"}
```

`baseRefName` is the chained branch — gh CLI honored `--base`.

A parallel test using `gh api` (the workaround) on a second head branch produced PR #179 with the same correct outcome:

```bash
gh api -X POST /repos/ai-sdlc-framework/ai-sdlc/pulls \
  -f title='test' -f head='test/aisdlc-129-head-2' -f base='test/aisdlc-129-base'
# {"base":"test/aisdlc-129-base","head":"test/aisdlc-129-head-2","number":179, ...}
```

Both paths work. Both are equally valid. The choice between them is whether you want gh CLI's UX niceties (auto-fill, editor integration, fork detection) or REST's explicitness.

---

## Why the misdiagnosis happened

The task description (AISDLC-129) said:

> When opening AISDLC-128 PR #157 with `gh pr create --base ai-sdlc/aisdlc-126-... --head ai-sdlc/aisdlc-128-...`, GitHub silently used `base=main` instead.

Investigation shows: that exact `gh pr create --base ... --head ...` call was almost certainly **not** what the orchestrator ran. The orchestrator's Step 11 implementation (`pipeline-cli/src/steps/11-push-and-pr.ts:121-125`) hardcodes:

```ts
const prResult = await runner(
  'gh',
  ['pr', 'create', '--title', title, '--body', body, '--base', 'main', '--head', opts.branch],
  { cwd: opts.worktreePath, allowFailure: true },
);
```

The slash-command spec at `ai-sdlc-plugin/commands/execute.md:597-603` carries the same hardcoded literal:

```bash
gh pr create \
  --title "<composed title>" \
  --body "<composed body>" \
  --base main \
  --head "$BRANCH"
```

So when AISDLC-128 ran through `/ai-sdlc execute`, the orchestrator opened PR #157 with `--base main` regardless of whether AISDLC-126's branch was the conceptual parent. The downstream `StackedPRBaseSquashed` failure (RFC-0015 §5.1) then fired correctly because once AISDLC-126 was merged, AISDLC-128's branch contained AISDLC-126's commits with stale parent SHAs.

**Bug location**: orchestrator hardcoding, not gh CLI.

---

## gh CLI's actual `--base` resolution

Per `cli/cli` source (`pkg/cmd/pr/create/create.go` ~line 786, gh 2.72.0):

```go
baseBranch := opts.BaseBranch              // --base flag value
if baseBranch == "" {
    baseBranch = branchConfig.MergeBase    // git config branch.<current>.gh-merge-base
}
if baseBranch == "" {
    baseBranch = baseRepo.DefaultBranchRef.Name  // repo's default branch (here: main)
}
```

The fallback chain is:

1. `--base <flag>` (if passed)
2. `git config branch.<current-branch>.gh-merge-base <branch>` (if set; documented at gh CLI [issue #10088](https://github.com/cli/cli/issues/10088))
3. Repo default branch

`--base`, when passed, wins. There is no documented behavior where `--base` is silently overridden by anything else. The flag is also documented to take a `--base` short alias `-B` and supports cross-repo refs like `monalisa:feature` (from the `gh pr create --help` examples).

If a future gh CLI release changes this resolution, the docstring at line 232 of `create.go` would change too — that string is a stable contract.

---

## Known gh CLI gotchas (worth knowing)

These are real and documented but are NOT what hit us:

- **Fork repos** can confuse base detection — `gh` may resolve the parent (upstream) repo as the base repo by default, which is correct for most fork PR workflows but surprises folks who want a fork-internal PR. Tracked at [cli/cli#12380](https://github.com/cli/cli/issues/12380). `ai-sdlc-framework/ai-sdlc` is NOT a fork, so this doesn't apply here.
- **`gh-merge-base` git branch config** can override `--base` if `--base` is omitted (cli/cli#10088 added this in 2024). If a previous tool wrote `git config branch.<name>.gh-merge-base main` for our branches, an *empty* `gh pr create` would use `main`. Our orchestrator never omits `--base`, so this also doesn't bite us.
- **`gh pr create` from the base branch itself** prints a warning but still creates the PR; cli/cli#11903 wanted it to abort, closed without that change.
- **Existing PRs**: `gh pr create` aborts cleanly with `a pull request for branch "X" into branch "Y" already exists` if a PR with the same `(head, base)` is open. It does NOT silently retarget — confirmed in `create.go:471-484`. So no "the previous PR's base was used" confusion.
- **`--dry-run` does NOT validate** that `--base` exists on the remote. A typo like `--base typo-branch --dry-run` will print a happy preview. Catch base typos with the `scripts/gh-stacked-pr.sh` wrapper, which calls `gh api /repos/.../branches/<base>` to confirm existence before posting.

---

## Workaround helper: `scripts/gh-stacked-pr.sh`

A thin wrapper that:

1. Validates `--base` and `--head` both exist on the remote (one `gh api` call each).
2. Posts the PR via `gh api -X POST /repos/<owner>/<repo>/pulls -f base=... -f head=... -f title=... -f body=...` — explicit and resilient to any future gh CLI surface drift.
3. Prints the resulting PR's `html_url` to stdout (compatible with the `gh pr create` UX).

Usage:

```bash
./scripts/gh-stacked-pr.sh \
  --base ai-sdlc/aisdlc-126-... \
  --head ai-sdlc/aisdlc-128-... \
  --title "feat(...): X (AISDLC-128)" \
  --body "..."
```

Optional `--repo <owner/repo>` if you're not in a checkout of the target repo, `--draft`, and `--body-file <path>` for long bodies.

The helper is **not yet wired into `/ai-sdlc execute` Step 11**. That's the AISDLC-129 follow-up work — once the orchestrator gains a chained-PR mode, Step 11 swaps the literal `--base main` for a per-task `--base <chained-or-main>` lookup and calls this helper. Today, Step 11 ships PRs into `main` exclusively, which is by design (one PR per task, no chains by default).

---

## Detection guard recommendation

If a future Step 11 becomes chain-aware, the orchestrator should also emit a warning when the resulting PR's `baseRefName` differs from the `--base` it requested:

```bash
PR_NUMBER=$(gh pr create --base "$EXPECTED_BASE" --head "$BRANCH" --title ... --body ... | sed 's|.*/||')
ACTUAL_BASE=$(gh pr view "$PR_NUMBER" --json baseRefName -q '.baseRefName')
if [ "$ACTUAL_BASE" != "$EXPECTED_BASE" ]; then
  echo "WARN: requested --base $EXPECTED_BASE but PR opened with base $ACTUAL_BASE"
  # surface to operator; do NOT auto-correct (that requires gh pr edit which can re-trigger reviews)
fi
```

This is defense-in-depth against future gh CLI regressions or operator-config drift (a stray `gh-merge-base` git config on the worktree branch). Not needed today because Step 11 hardcodes `--base main` — there's nothing to drift from.

---

## RFC-0015 §5.1 trigger note

The `StackedPRBaseSquashed` row says "the base PR was squash-merged" but `ai-sdlc-framework/ai-sdlc` uses **rebase-merge** (per `gh repo view --json viewerDefaultMergeMethod`: `REBASE`). PR #154 (AISDLC-126) was rebase-merged, not squash-merged, and the failure still fired — because rebase-merge also rewrites commit SHAs, so a child branch's parent commits no longer exist on the merged base. The RFC trigger condition has been broadened to "non-merge-commit strategy (rebase OR squash)" in the row's detection clause to match observed reality.

---

## Cleanup commands (for the AISDLC-129 reproduction artifacts)

The reproduction left behind:

- Test branches: `test/aisdlc-129-base`, `test/aisdlc-129-head`, `test/aisdlc-129-head-2` on `origin`.
- Test PRs: #178 (reopened — investigation hit Hard Rule #3 mid-run), #179.

These are the operator's call to dispose of. Suggested cleanup (operator-run, not agent-run, per Hard Rules #3 and #4):

```bash
gh pr close 178 --repo ai-sdlc-framework/ai-sdlc --delete-branch
gh pr close 179 --repo ai-sdlc-framework/ai-sdlc --delete-branch
git push origin --delete test/aisdlc-129-base
```

Branches and PRs are clearly marked `[DO NOT MERGE]` and contain only `.aisdlc-129-*-marker.txt` placeholder files.
