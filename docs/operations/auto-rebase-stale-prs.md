# Auto-rebase stale PRs on push-to-main (Option A)

**AISDLC-420** — This runbook describes the auto-rebase workflow that fires
on every push to `main` and rebases every open same-repo non-draft PR whose
`mergeStateStatus` is `DIRTY` or `BEHIND`. It is the **Option A** sibling to
the existing `auto-rebase-open-prs.yml` (AISDLC-138 / AISDLC-189): Option A
performs the rebase **locally in a temp worktree** instead of via
`gh pr update-branch`, which gives the operator a structured JSON summary the
[orchestrator-tick](../../pipeline-cli/docs/orchestrator.md) can consume.

**Critically, the workflow does NOT re-sign attestation envelopes.** The
v6 envelope's `subject.digest.sha1` binding is invalidated by any rebase, so
after this workflow pushes the rebased branch the PR's attestation goes red.
That is by design — only the operator's local signing key can produce a new
envelope. The next `/ai-sdlc orchestrator-tick` includes a sweep step that
walks red-attestation PRs and re-signs them in the operator's worktrees.

## What this workflow does

1. **Trigger**: every push to `main` (workflow `on.push.branches: [main]`).
2. **Scope**: every open PR in the same repo (forks excluded by token scope),
   non-draft, with `mergeStateStatus` `DIRTY` or `BEHIND`.
3. **Action per PR**:
   - Create a temp worktree at `$TMPDIR/aisdlc-rebase-<n>-XXXX`.
   - `git fetch origin <branch>`.
   - `git rebase origin/main`.
   - **On clean rebase**: `git push --force-with-lease origin HEAD:<branch>`
     and comment on the PR with
     `auto-rebased onto main (operator must re-sign locally — run /ai-sdlc orchestrator-tick to sweep)`.
   - **On conflict**: `git rebase --abort`, comment on the PR with the
     conflicting files, add label `needs-manual-rebase`.
   - **Always**: remove the temp worktree (success or failure path).
4. **Output**: a JSON summary on `stdout`:
   ```json
   {
     "rebased": [{ "pr": 101, "branch": "feat/foo", "status": "clean" }],
     "conflicted": [{ "pr": 202, "branch": "feat/bar", "files": ["src/x.ts"] }],
     "skipped": [{ "pr": 303, "reason": "draft" }],
     "pushErrors": [],
     "fetchErrors": []
   }
   ```

## Pre-flight: git identity required

The script refuses to run unless **both** `git config user.email` and
`git config user.name` are set. The workflow sets:

```
git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"
```

This protects developer machines that accidentally invoke the script — without
the identity, every rebase commit would carry the developer's personal email.

## Re-sign after auto-rebase (operator recipe)

After the workflow pushes a rebased branch, the PR's attestation envelope's
embedded `subject.digest.sha1` no longer matches the new HEAD SHA. The
`verify-attestation` check posts `ai-sdlc/attestation: failure` and the PR
sits red until the operator re-signs locally.

Standard recovery (mirrors [`docs/operations/merge-queue-rebase-recovery.md`](merge-queue-rebase-recovery.md)
in shape, applied per-PR):

```bash
# 1. From the project root, enter the affected worktree.
cd .worktrees/<task-id>

# 2. Pull the auto-rebased HEAD (the workflow already pushed it).
git fetch origin
git reset --hard origin/<branch>

# 3. Drop the stale envelope.
node scripts/drop-stale-attestation-envelope.mjs --apply

# 4. Re-sign with your existing verdict file.
node ai-sdlc-plugin/scripts/sign-attestation.mjs \
  --review-verdicts .ai-sdlc/verdicts/<task-id-lower>.json

# 5. Push the chore commit; --force-with-lease re-protects against drift.
git push --force-with-lease
```

The next `/ai-sdlc orchestrator-tick` automates this loop across every
red-attestation PR — that is the canonical recovery path. See
[`pipeline-cli/docs/orchestrator.md`](../../pipeline-cli/docs/orchestrator.md)
for the tick's red-attestation sweep step.

## Conflict failure mode

When `git rebase origin/main` exits non-zero inside the temp worktree:

1. The script captures conflicting files via
   `git diff --name-only --diff-filter=U`.
2. Runs `git rebase --abort` (returns the worktree to a clean state).
3. Posts a PR comment:
   `auto-rebase aborted: conflicts in <file>, <file> — manual rebase needed`.
4. Adds label `needs-manual-rebase`.

The operator resolves the conflict using the standard tooling
(`/ai-sdlc rebase <pr>` for mechanical conflicts, manual editor for
semantic ones). The label is the operator-facing signal that the workflow
has done as much as it can — see the [Git Flow](../../CLAUDE.md#git-flow)
section of `CLAUDE.md`.

## Smoke-test instructions (dry-run)

The script supports `--dry-run`: it walks the real `gh` API, performs the
real local rebases inside temp worktrees, but **does not** push, comment, or
add labels.

```bash
# Pre-requisite: gh auth status must show a valid token.
gh auth status

# From the repo root:
node scripts/auto-rebase-stale-prs.mjs --dry-run

# The script writes a JSON summary to stdout and progress logs to stderr.
# Pipe stdout to a file if you want to diff against the apply mode:
node scripts/auto-rebase-stale-prs.mjs --dry-run > /tmp/rebase-summary.json
```

The dry-run is safe to invoke anywhere — it performs no writes to GitHub
state. It does, however, perform local `git fetch` calls to `origin`, so it
needs a writable clone with a working `origin` remote.

For a fully hermetic local smoke (no real `gh` calls), invoke the test
suite directly:

```bash
pnpm test:auto-rebase-stale-prs
```

The test suite exercises the 8 acceptance-criteria cases with mock `gh` and
`git` binaries injected via `AI_SDLC_REBASE_GH_BIN` and
`AI_SDLC_REBASE_GIT_BIN`. No network access required.

## Rollback

To disable the workflow without removing it from history:

```bash
git mv .github/workflows/auto-rebase-stale-prs.yml \
       .github/workflows/auto-rebase-stale-prs.yml.disabled
git commit -m "chore(ci): disable auto-rebase-stale-prs workflow (operator override)"
git push
```

GitHub Actions only fires `.yml` files inside `.github/workflows/`; renaming
to `.yml.disabled` is the canonical pause-without-delete pattern.

To re-enable, reverse the rename and push.

## Workflow YAML (operator drops into `.github/workflows/auto-rebase-stale-prs.yml`)

This dev PR cannot edit `.github/workflows/**` (PreToolUse hook blocks it
per AC #6). The operator drops the following YAML into
`.github/workflows/auto-rebase-stale-prs.yml` in a follow-up commit on the
same PR after the script + tests + docs land.

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

### Token note

The YAML above uses `secrets.GITHUB_TOKEN`. Per
[`auto-rebase-token-setup.md`](auto-rebase-token-setup.md), pushes made with
`GITHUB_TOKEN` do **not** trigger downstream workflows — so the rebased PR's
new HEAD SHA will have zero CI runs and `ai-sdlc/pr-ready` will not fire on
the new SHA until something else kicks CI (an `auto-rearm-auto-merge.yml`
empty-commit kick, an operator-pushed re-sign, etc.).

If you have already provisioned the `AI_SDLC_PAT` secret for the sibling
`auto-rebase-open-prs.yml` workflow (Option B from `auto-rebase-token-setup.md`),
swap the token line in the YAML above to:

```yaml
        env:
          GH_TOKEN: ${{ secrets.AI_SDLC_PAT || secrets.GITHUB_TOKEN }}
```

— same fallback pattern as the existing workflow. The `secrets.AI_SDLC_PAT`
push will fire downstream CI on the rebased SHA without an extra re-kick.

## Out of scope (explicit)

- **Re-sign automation (Option B)** — moving the signing key into CI changes
  the meaning of an attestation signature and requires its own RFC.
- **Conflict resolution beyond aborting + labelling** — the existing
  `/ai-sdlc rebase <pr>` rebase-resolver agent handles that for explicit
  operator invocations.
- **Slack / digest notifications** — the existing `events.jsonl` writer
  surfaces the JSON summary; a Slack adapter is a future enhancement.

## References

- AISDLC-419 — attestation-only-descendant relaxation that catches the stale envelopes after a rebase
- AISDLC-356 — auto-rearm-auto-merge after force-push (sister automation)
- AISDLC-400 — merge-queue removal (context for why DIRTY now matters)
- AISDLC-138 + AISDLC-189 — the existing `auto-rebase-open-prs.yml` workflow this complements
- [`auto-rebase-token-setup.md`](auto-rebase-token-setup.md) — token provisioning
- [`merge-without-queue.md`](merge-without-queue.md) — merge flow after AISDLC-400
