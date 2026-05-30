---
id: AISDLC-484
title: >-
  Fix dead docs-only CI fast-path: dorny/paths-filter@v3 with
  predicate-quantifier:every never fires
status: To Do
assignee: []
created_date: '2026-05-30 00:00'
labels:
  - bug
  - ci
  - docs
  - cost
  - performance
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## Context

A 2026-05-30 diagnosis found the docs-only CI fast-path in
`.github/workflows/ai-sdlc-gate.yml` has never fired in production. The `detect`
job uses `dorny/paths-filter@v3` with `predicate-quantifier: every` to set a
`docs_only` output that should let `build-test`, `coverage`, and `integration`
jobs skip for changesets touching only `spec/rfcs/**`, `docs/**`, `backlog/**`,
and root markdown. In practice the action returns `docs_only = false` with
"Matching files: none" for every docs-only PR (observed on PR #765 and PR #776 —
both pure RFC doc PRs that ran the full ~15-minute test matrix unnecessarily).
The standalone detector `scripts/is-docs-only-changeset.mjs` classifies the same
file list correctly as docs-only (verified: a list of two `spec/rfcs/**` files
returns `true`), so the bug is isolated to the `dorny/paths-filter` action
wrapper and its `predicate-quantifier: every` semantics, not the classification
logic. The local workflow test models a hand-rolled JS implementation rather than
exercising the action at runtime, so it never caught the divergence.

The current detect job (lines 92-118 of `.github/workflows/ai-sdlc-gate.yml`)
looks like this:

```yaml
detect:
  name: Detect Changes
  runs-on: ubuntu-latest
  if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
  outputs:
    docs_only: ${{ steps.filter.outputs.docs_only }}
  steps:
    - uses: actions/checkout@v4
    - id: filter
      uses: dorny/paths-filter@v3
      with:
        predicate-quantifier: 'every'
        filters: |
          docs_only:
            - 'spec/rfcs/**'
            - 'docs/**'
            - 'backlog/tasks/**'
            - 'backlog/completed/**'
            - '*.md'
```

## Impact

Every documentation PR (RFCs, docs, backlog tasks) runs the full Build & Test
(Node 20 + 22), Coverage, and Integration matrix — roughly 15 minutes of CI
compute per docs PR that should complete in seconds. This is a direct contributor
to PR friction and wasted CI minutes.

## Proposed fix

Replace the `dorny/paths-filter@v3` step in the `detect` job with a deterministic
shell step that shells out to the already-correct `scripts/is-docs-only-changeset.mjs`,
feeding it the PR's changed-file list via `git diff --name-only`. Set the job's
`docs_only` output from the script result.

The ready-to-paste replacement for the `detect` job is:

```yaml
detect:
  name: Detect Changes
  runs-on: ubuntu-latest
  # AISDLC-218: skip on draft PRs. Subsequent jobs `needs: detect` so this
  # cascades — a draft event causes no jobs to run at all.
  if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
  outputs:
    docs_only: ${{ steps.classify.outputs.docs_only }}
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - name: Classify changeset
      id: classify
      env:
        BASE_SHA: ${{ github.event.pull_request.base.sha }}
        HEAD_SHA: ${{ github.event.pull_request.head.sha }}
      run: |
        # Compute the list of changed files between PR base and head.
        # Falls back to listing all files tracked at HEAD when the base SHA
        # is unavailable (e.g. on merge_group events — though merge_group is
        # currently disabled per AISDLC-400).
        if [ -n "$BASE_SHA" ] && git cat-file -e "$BASE_SHA" 2>/dev/null; then
          FILES=$(git diff --name-only "$BASE_SHA" "$HEAD_SHA")
        else
          FILES=$(git ls-files)
        fi

        RESULT=$(printf '%s\n' "$FILES" | node scripts/is-docs-only-changeset.mjs)
        echo "docs_only=$RESULT" >> "$GITHUB_OUTPUT"
```

Key properties of this replacement:
- Preserves the existing `draft == false` guard (AISDLC-218).
- Preserves the `docs_only` job output key consumed by downstream `needs.detect.outputs.docs_only` guards on `build-test`, `coverage`, and `integration`.
- Uses `scripts/is-docs-only-changeset.mjs` — the single source of truth for
  docs-only classification already used by `verify-attestation.yml` and
  `ai-sdlc-review.yml` for `merge_group` short-circuits (AISDLC-206).
- `fetch-depth: 0` ensures the base SHA is present for `git diff`.
- The fallback to `git ls-files` prevents silent false-negatives on events
  where `base.sha` is absent.

The operator applies this change to `.github/workflows/ai-sdlc-gate.yml` directly
(automated agents cannot apply workflow edits per the PreToolUse hook).

## Acceptance Criteria

- [ ] #1 The `detect` job in `.github/workflows/ai-sdlc-gate.yml` determines `docs_only` via `scripts/is-docs-only-changeset.mjs` (or equivalent deterministic logic), not `dorny/paths-filter`'s `predicate-quantifier: every`.
- [ ] #2 A docs-only PR (only `spec/rfcs/**` / `docs/**` / `backlog/**` / root `*.md`) skips Build & Test, Coverage, and Integration; `ai-sdlc/pr-ready` still posts SUCCESS so the PR merges.
- [ ] #3 A PR touching any source file still runs the full matrix (no false-negative docs classification).
- [ ] #4 The workflow test (`.github/workflows/__tests__/ai-sdlc-gate.test.mjs`) is updated to exercise the actual detect mechanism (not a separate hand-rolled model), including a mixed docs+source changeset that must NOT classify as docs-only.
- [ ] #5 Verified on a real docs-only PR that the skipped jobs do not run and the PR still merges on the two required checks.

## Notes

The fix is a `.github/workflows/**` edit, which automated agents cannot apply
(PreToolUse hook blocks it); the operator or a human contributor applies the
workflow change. The task body carries the ready-to-paste detect-job YAML so
application is mechanical.

<!-- SECTION:DESCRIPTION:END -->
