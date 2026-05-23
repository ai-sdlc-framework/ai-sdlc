---
id: AISDLC-401
title: 'feat(release): release-please CHANGELOG appends only on release PR, not per-PR'
status: Done
labels: [release-please, ci, operator-merge, throughput]
references:
  - release-please-config.json
  - .release-please-manifest.json
  - .github/workflows/release.yml
priority: high
permittedExternalPaths: []
---

## Description

Every PR that lands modifies CHANGELOG.md via release-please's per-PR append behavior. With the merge queue dropped (AISDLC-400) PRs now land in parallel — every PR pair touching CHANGELOG generates a mechanical conflict that operator must rebase. Operator architectural review (2026-05-23) chose release-please's "release-PR only" model: bot maintains a single rolling `chore(release): X.Y.Z` PR that accumulates all unreleased changes from commit messages; regular PRs do not modify CHANGELOG.

## Acceptance criteria

- [x] AC-1: Audit current `release-please-config.json` + `.github/workflows/release.yml` to identify what currently triggers per-PR CHANGELOG edits. Likely candidates: a workflow that calls release-please on every push to main, or a config like `"changelog-host"`/`"prerelease"` that triggers per-commit appends.
- [x] AC-2: Reconfigure so release-please only opens/updates the rolling release PR. The release PR contains the cumulative CHANGELOG diff + version bump. Regular feature PRs MUST NOT contain CHANGELOG.md changes.
- [x] AC-3: Pre-push hook (NEW or update existing): WARN when a regular PR's diff includes CHANGELOG.md changes. The warning suggests removing the manual edit (release-please will pick up the commit on next release-PR refresh).
- [x] AC-4: Update `CLAUDE.md` "Releases" section: document the new flow — contributors do NOT edit CHANGELOG; release-please bot maintains the cumulative release PR; merging the release PR triggers npm publish.
- [x] AC-5: Migration: delete the per-PR `CHANGELOG.md` Unreleased sections that have accumulated since the last release. Reset to "## [Unreleased]" empty section. release-please will reconstruct from commit history.
- [x] AC-6: Hermetic test at `.github/workflows/__tests__/release-please-config.test.mjs`: parses release-please-config.json + asserts settings that prevent per-PR CHANGELOG edits.
- [x] AC-7: Documentation update at `docs/operations/release-flow.md` (NEW): explains release-please bot behavior, when to expect the release PR to update, how to manually trigger a release PR refresh if needed.
- [x] AC-8: Reference AISDLC-400 (queue drop) as the trigger — collision rate became visible once parallel merges were enabled.

## Out of scope

- Migrating to changesets entirely (deferred; release-please's release-PR model achieves same outcome with minimal change).
- Reformatting the existing CHANGELOG.md structure (just truncate Unreleased section to empty).
- Changing publish workflow (`.github/workflows/release.yml`) — only the changelog generation behavior changes, not what gets published.

## References

- AISDLC-400 (drop merge queue) — prerequisite, made the collision visible
- release-please docs: googleapis/release-please on GitHub

## Estimated effort

30 min - 1 hour. Mostly config changes + a couple of docs files.
