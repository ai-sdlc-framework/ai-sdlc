---
id: AISDLC-244
title: >-
  auto-enable-auto-merge uses GITHUB_TOKEN which anti-recursion blocks
  merge_group CI from firing — root cause of every queue stall today
status: To Do
assignee: []
created_date: '2026-05-08 02:55'
labels:
  - bug
  - ci
  - merge-queue
  - framework-bug
  - dogfood
  - p0
dependencies: []
priority: high
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - CLAUDE.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`auto-enable-auto-merge.yml` arms auto-merge via `gh pr merge --auto` using `secrets.GITHUB_TOKEN`. GitHub's anti-recursion protection prevents workflows from firing on events triggered by `GITHUB_TOKEN`:

> "When you use the repository's GITHUB_TOKEN to perform tasks, events triggered by the GITHUB_TOKEN, with the exception of workflow_dispatch and repository_dispatch, will not create a new workflow run."
> — [GitHub Docs: Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)

So when `auto-enable-auto-merge.yml` (running as `github-actions[bot]`) arms auto-merge → queue admits PR → produces a `merge_group` commit → **GitHub does NOT dispatch workflows for that commit because the chain originated from `GITHUB_TOKEN`**. Required checks (`ai-sdlc/attestation`, `ai-sdlc/pr-ready`, `Backlog Drift`, `codecov/patch`) never report → PR sits CLEAN+armed forever in the queue.

## Witnessed empirically 2026-05-07/08 (multiple times today)

Every PR opened today by an automated workflow (`auto-enable-auto-merge.yml` armed it via GITHUB_TOKEN) hit this:
- PR #392 (AISDLC-178.6) — needed manual dequeue+re-arm
- PR #393 (AISDLC-230) — needed manual dequeue+re-arm  
- PR #394 (4 framework-gap tasks) — needed manual dequeue+re-arm
- PR #395 (TUI shortcut + 235/236) — needed manual dequeue+re-arm
- PR #398 (AISDLC-240) — needed manual dequeue+re-arm
- PR #399 (mark 178.7 blocked) — needed manual dequeue+re-arm
- PR #400 (3 framework gaps 241/242/243) — needed manual dequeue+re-arm
- PR #401 (AISDLC-237) — needed manual dequeue+re-arm

**Manual workaround that always works:** dequeue + re-arm with the operator's user PAT:
```
PR_ID=$(gh pr view <N> --json id --jq .id)
gh api graphql -f query="mutation { dequeuePullRequest(input: { id: \"$PR_ID\" }) { mergeQueueEntry { position } } }"
gh pr merge <N> --auto
```
The `gh pr merge --auto` call uses the operator's PAT (when invoked from a developer terminal), which is NOT subject to anti-recursion → workflows fire on the resulting merge_group commit.

This explains:
1. Why `auto-enable-auto-merge.yml` SEEMS to work but PRs sit forever in queue
2. Why manual operator intervention is required for every PR today
3. Why AISDLC-230's "re-arm on check_suite.completed" fix didn't fully solve it (the re-arm STILL uses GITHUB_TOKEN, hits the same anti-recursion wall)

## Proposed fix

### Option A — Use a Personal Access Token (PAT) stored as repo secret

Create a fine-grained PAT with `pull-requests: write` + `contents: read` scope, store as `AUTO_MERGE_PAT` secret. Update `auto-enable-auto-merge.yml`:

```yaml
- name: Refresh auto-merge (via PAT to bypass anti-recursion)
  env:
    GH_TOKEN: ${{ secrets.AUTO_MERGE_PAT }}  # NOT GITHUB_TOKEN
    GH_REPO: ${{ github.repository }}
    PR: ${{ steps.discover.outputs.pr }}
  run: |
    gh pr merge --disable-auto "$PR" 2>/dev/null || true
    gh pr merge --auto "$PR"
```

Tradeoff: requires operator to mint a PAT + manage rotation. Token has elevated permissions (worth scoping tightly).

### Option B — Use a GitHub App token

Mint a GitHub App with the right permissions, install it on the repo, generate per-run installation tokens via `actions/create-github-app-token`. Tokens issued by GitHub Apps DO trigger workflows.

```yaml
- name: Mint GitHub App token
  id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.AUTO_MERGE_APP_ID }}
    private-key: ${{ secrets.AUTO_MERGE_APP_PRIVATE_KEY }}

- name: Refresh auto-merge
  env:
    GH_TOKEN: ${{ steps.app-token.outputs.token }}
    GH_REPO: ${{ github.repository }}
    PR: ${{ steps.discover.outputs.pr }}
  run: |
    gh pr merge --disable-auto "$PR" 2>/dev/null || true
    gh pr merge --auto "$PR"
```

Tradeoff: more setup (create + install + maintain a GitHub App), but tokens auto-rotate (no manual rotation), per-run scope, audit trail attributed to the App not a user.

### Option C — Document the limitation + retain manual workaround

If neither A nor B is acceptable, update CLAUDE.md operator runbook to make the manual dequeue+re-arm trick the canonical procedure (clearly documented, scriptable as a `/ai-sdlc nudge-queue <pr>` slash command).

Tradeoff: every PR requires manual nudge. Defeats autonomous orchestrator vision.

## Recommendation

**Option A (PAT)** — operator confirmed `AI_SDLC_PAT` secret already exists. This PR ships the swap of `GITHUB_TOKEN` → `AI_SDLC_PAT` in the 3 `GH_TOKEN:` lines of `auto-enable-auto-merge.yml`. Single-line change × 3 occurrences, immediate fix.

## Acceptance Criteria

- [ ] #1 Confirm root cause empirically: open a fresh PR, observe auto-enable-auto-merge.yml arms it, observe queue admission produces merge_group commit with ZERO workflow runs (visible via `gh run list --commit <sha>`)
- [ ] #2 Pick Option A, B, or C (operator decision based on PAT/App tradeoffs)
- [ ] #3 If A or B: implement the token swap in `.github/workflows/auto-enable-auto-merge.yml`; secret created + documented in repo README + operator runbook
- [ ] #4 If C: ship a `/ai-sdlc nudge-queue <pr-number>` slash command that scripts the dequeue+re-arm; document in operator runbook
- [ ] #5 End-to-end verification: open a PR, let auto-enable-auto-merge fire, queue admits, merge_group commit gets workflow runs without manual intervention
- [ ] #6 Update CLAUDE.md to remove the misleading line "auto-enable-auto-merge.yml sets --auto on same-repo PRs ... no manual click needed" and add the actual flow
- [ ] #7 Cross-reference AISDLC-230 (the partial fix that thought it solved the trigger gap) — note that 230 fixed the WORKFLOW trigger event, not the WORKFLOWS-firing-on-merge_group issue this task addresses

## Composes with

- **AISDLC-230** (re-arm on check_suite.completed) — partial fix that addressed PR-side staleness but missed the GITHUB_TOKEN issue
- **AISDLC-237** (contentHashV4 — separate concern, but witnessed alongside this bug)
- **AISDLC-241** (git config race — separate parallel-dispatch concern)

## References

- `.github/workflows/auto-enable-auto-merge.yml` (the workflow with the GITHUB_TOKEN issue)
- `CLAUDE.md` PRs section (currently overpromises auto-merge behavior)
- GitHub Docs: [Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
- AISDLC-230 (sister fix that this task complements)
- Operator insight 2026-05-08 02:55: "I think it's our auto action to remove and add it to the queue, since it's the github action that's doing it and not my user key it's not triggering the ci/cd run in the queue"
- 8+ PRs today witnessed needing manual dequeue+re-arm — empirical proof of the bug
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Empirically confirm root cause (fresh PR, observe zero merge_group workflow runs after bot-attributed arm)
- [ ] #2 Pick Option A (PAT), B (GitHub App), or C (document workaround) per operator
- [ ] #3 Implement token swap in workflow + secret setup if A or B
- [ ] #4 If C: /ai-sdlc nudge-queue slash command + runbook
- [ ] #5 End-to-end verification: queue admission produces merge_group with workflows firing automatically
- [ ] #6 Update CLAUDE.md to remove misleading auto-merge promise + describe actual flow
- [ ] #7 Cross-reference AISDLC-230 (partial fix)
<!-- SECTION:ACCEPTANCE:END -->
