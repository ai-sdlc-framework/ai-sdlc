# Auto-rebase Token Setup

**AISDLC-189** — The `auto-rebase-open-prs.yml` workflow must use a non-`GITHUB_TOKEN`
credential when it force-pushes rebased PR branches. Pushes made with `GITHUB_TOKEN`
are subject to GitHub's [recursive-workflow-prevention rule](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
which blocks downstream workflows from firing on those pushes.

Without a PAT/App token configured, every auto-rebase pass leaves the rebased PR's
new HEAD SHA with zero CI runs — the required `ai-sdlc/pr-ready` check never fires
and the PR sits BLOCKED despite being mergeable and having auto-merge armed.

## Why GITHUB_TOKEN isn't enough

GitHub prevents recursive workflow triggering: when a workflow pushes using
`GITHUB_TOKEN`, no other workflow fires on that push. This is a deliberate
GitHub safety measure, not a bug.

The `auto-rebase-open-prs.yml` workflow uses `gh pr update-branch --rebase`
which internally does a force-push to the PR branch. With `GITHUB_TOKEN`, that
push is invisible to downstream workflows. With a PAT or GitHub App token, the
push is treated as a user-initiated push and downstream workflows fire normally.

## Secret: `AI_SDLC_PAT`

The workflow reads `secrets.AI_SDLC_PAT || github.token`. If `AI_SDLC_PAT` is
set, the rebase push triggers downstream workflows. If unset, the workflow falls
back to `GITHUB_TOKEN` and emits a `::warning::` annotation in the run log.

This secret is shared with other AI-SDLC workflows that need elevated token
permissions. If you've already configured `AI_SDLC_PAT` for another workflow,
the auto-rebase fix is already active.

## Setup steps

### Option A: Fine-grained PAT (recommended)

1. Navigate to <https://github.com/settings/personal-access-tokens/new>

2. Configure the token:
   - **Token name**: `ai-sdlc-automation` (or similar)
   - **Expiration**: 1 year (set a calendar reminder for rotation)
   - **Repository access**: Only select repositories → choose this repo
   - **Repository permissions**:
     - Contents: **Read and write**
     - Pull requests: **Read and write**

3. Generate and copy the token.

4. Add it as a repo secret:

   ```bash
   gh secret set AI_SDLC_PAT -b <paste-token-here>
   ```

5. Verify the secret is set:

   ```bash
   gh secret list | grep AI_SDLC_PAT
   ```

### Option B: GitHub App token

If you have a GitHub App installed on the repo with `contents:write` and
`pull-requests:write` permissions, replace the `env.GH_TOKEN` assignment
in `auto-rebase-open-prs.yml` with:

```yaml
- uses: actions/create-github-app-token@v2
  id: app-token
  with:
    app-id: ${{ secrets.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
```

Then reference `${{ steps.app-token.outputs.token }}` instead of `secrets.AI_SDLC_PAT`.

## Required scopes

| Scope | Why |
|---|---|
| `contents: write` | Force-push to PR branches after rebase |
| `pull-requests: write` | `gh pr update-branch` API calls |

## Rotation policy

- Set a calendar reminder 2 weeks before the PAT expires.
- Rotate via <https://github.com/settings/personal-access-tokens> → regenerate.
- Update the secret immediately: `gh secret set AI_SDLC_PAT -b <new-token>`.
- The workflow falls back to `GITHUB_TOKEN` (degraded mode) if the secret
  expires — look for `::warning::AI_SDLC_PAT secret unset` in the
  [auto-rebase workflow run logs](../../.github/workflows/auto-rebase-open-prs.yml).

## Verification

After setting the secret:

1. Open a trivial docs-only PR (e.g. one-line change to any `*.md` file).
2. Push a separate commit to `main` (e.g. another docs change) so auto-rebase fires.
3. Within 60 seconds of the auto-rebase run completing, check the PR:
   - The head SHA should have changed.
   - `gh run list --branch <branch-name>` should show new CI runs fired on the new SHA.
   - The PR's status checks panel should show checks running (not the "no runs" empty state).

## Symptom: workflow fell back to GITHUB_TOKEN

If the secret is missing or expired, the auto-rebase workflow emits:

```
::warning::AI_SDLC_PAT secret unset — falling back to GITHUB_TOKEN.
Rebased PR SHAs will NOT trigger downstream workflows; operators must
manually re-kick. See .github/workflows/auto-rebase-open-prs.yml header
for setup.
```

**Manual recovery for a blocked PR**: push an empty commit on the branch to
retrigger CI:

```bash
git checkout <branch-name>
git commit --allow-empty -m "chore: retrigger ci"
git push
```

## References

- [AISDLC-189 task](../../backlog/completed/aisdlc-189%20-%20Auto-rebase-workflow-uses-GITHUB_TOKEN-%E2%80%94-rebased-PR-SHAs-never-trigger-CI.md)
- [GitHub: Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
- [auto-rebase-open-prs.yml](../../.github/workflows/auto-rebase-open-prs.yml)
