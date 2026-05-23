# Release Flow — release-please Rolling PR

> Triggered by: AISDLC-401 (parallel-merge CHANGELOG collision rate after AISDLC-400 queue drop)

## Model: rolling release PR

AI-SDLC uses [release-please](https://github.com/googleapis/release-please) in its
**rolling release PR** mode. The key invariant:

- **Regular feature PRs MUST NOT modify CHANGELOG.md.**
- **Only the rolling release PR** (`chore: release main`, maintained by
  `googleapis/release-please-action`) ever touches CHANGELOG.md.

This model eliminates the class of parallel-merge conflicts where two feature PRs
land simultaneously and both edit the `## Unreleased` section of a CHANGELOG —
a collision rate that became visible once the merge queue was dropped (AISDLC-400).

## How it works

1. **Developer pushes a feature branch** with conventional-commit messages
   (`feat:`, `fix:`, `chore:`, etc.). The CHANGELOG.md files stay untouched.

2. **PR merges to `main`** via the standard review flow. The squash-commit's
   subject line carries the conventional-commit prefix — this is what
   release-please reads.

3. **`release.yml` fires** on every push to `main`. It runs
   `googleapis/release-please-action@v4`, which:
   - Parses the new commit messages since the last release tag.
   - Opens or updates the single rolling PR titled `chore: release main` on
     the `release-please--branches--main` branch.
   - The rolling PR accumulates: version bumps in `package.json` files +
     CHANGELOG.md entries for each package.

4. **Operator merges the rolling release PR** when ready to cut a release.
   After merge, `release.yml`'s `publish-npm` job runs and pushes to npm.

## What contributors do (and don't do)

| Do | Don't |
|---|---|
| Write conventional-commit messages (`feat:`, `fix:`, etc.) | Edit CHANGELOG.md manually |
| Let release-please manage version bumps | Manually bump versions in package.json |
| Merge the rolling release PR when ready to ship | Merge the release PR before tests pass |

## Pre-push warning

The pre-push hook (`scripts/check-changelog-edit.sh`, AISDLC-401) emits a `WARNING`
when your branch includes CHANGELOG.md changes. This is **non-blocking** — the push
proceeds. But it signals that you likely need to revert those changes before the PR
can land cleanly alongside parallel PRs.

To silence the warning for a deliberate edit (rare):

```bash
AI_SDLC_SKIP_CHANGELOG_CHECK=1 git push
```

## How to trigger a release PR refresh

If the rolling release PR is stale (was closed, or you need to add a commit to the
next release after a long quiescent period), trigger a manual run:

```bash
gh workflow run release.yml --ref main
```

This runs `release-please-action` immediately, which opens a fresh rolling PR (or
updates the existing one if the branch still exists).

## Packages tracked by release-please

All packages listed in `release-please-config.json` under `packages:`. Each package
has a `release-type` (`node`, `python`, `go`, `simple`) and a corresponding entry in
`.release-please-manifest.json` that tracks the last-released version.

The `node-workspace` plugin keeps all `node`-type packages in sync (they share a
version number via the `linked-versions` plugin grouping `node-packages`).

## Troubleshooting

**The rolling PR is not picking up my commit.**
Ensure your merge-to-main commit subject starts with a recognized conventional-commit
type (`feat`, `fix`, `perf`, `revert`). Types like `chore`, `refactor`, `test`,
`ci`, `docs` are valid but hidden in the changelog (configured in `changelog-sections`
of `release-please-config.json`).

**I need to add a pre-release entry.**
Use a conventional-commit message with `!` for breaking changes (`feat!:`) or the
standard types. release-please will categorize it automatically.

**The rolling PR has a CHANGELOG conflict with a regular PR.**
This means a regular PR touched CHANGELOG.md. Identify the offending commit with:

```bash
git log --oneline --diff-filter=M -- '*/CHANGELOG.md' origin/main..HEAD
```

Then remove those CHANGELOG changes from the regular PR and push. The rolling PR
will reconstruct them from commit history.
