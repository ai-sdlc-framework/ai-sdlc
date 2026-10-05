---
id: AISDLC-702
title: >-
  Sanctioned merge path for release PRs: a release source kind in cli-merge-if-eligible
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - governance
  - release
dependencies: []
references:
  - pipeline-cli/bin/cli-merge-if-eligible.mjs
  - CLAUDE.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-03 the operator authorized cutting release PR #1105 (release-please,
"chore: release main"). No agent could land it. The governance hook (AISDLC-602,
resolved allowMerge="never") refuses raw `gh pr merge`, including `--auto`, and points to
`node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --arm`. That CLI requires
`--source-kind` and accepts only `backlog` and `gh-issue`. A release-please PR is neither,
and passing `backlog` would assert a false provenance. The operator merged #1105 by hand
and decided: agents acting on his explicit instruction must be able to merge release PRs
through a sanctioned path. The release section of CLAUDE.md still describes arming with
raw gh, which the hook blocks.

Goal: add a `release` source kind to `cli-merge-if-eligible` so an authorized session can
arm (or merge) the rolling release-please PR, with eligibility checks that are derived
from GitHub, not from caller-supplied claims.

Reference: operator decision 2026-10-03 ("you should have the authority to merge release
PRs").

## Conventions
- Trust-chain change: security review runs on the opus model. Keep the PR draft until
  CodeQL is clean.
- This task explicitly authorizes the CLAUDE.md edit in acceptance criterion 5.
- Hermetic `node --test` tests; the GitHub API client is injectable, no network in tests.

## Out of scope
- Changing when releases are cut. A release is still cut only on an explicit operator
  instruction each time.
- npm publish workflow changes.

## Acceptance Criteria
- [x] `cli-merge-if-eligible <pr> --source-kind release --arm` (and the non-arm merge form, if the CLI has one for other kinds) succeeds for a genuine release-please PR and uses the repo's allowed merge method (squash).
- [x] Eligibility for `release` is verified from the GitHub API, all of: the PR author is the release-please bot identity the repo's release workflow uses (resolve the actual login from the workflow and past release PRs such as #1078 and #1105; do not hardcode a guess); the head ref is exactly `release-please--branches--main` in the same repo (not a fork); the base is `main`; every commit on the PR is authored by that bot; the changed files are limited to an allowlist of release artifacts (CHANGELOG.md files, package manifests and version files, the release-please manifest, and the plugin manifest and pinned-version files that the AISDLC-577 pin-sync automation touches), and any other path makes the PR ineligible; all required checks are green.
- [x] A PR that fails any check is refused with a message naming the failed check. Tests cover: a human-authored PR on the release branch name, a fork PR, an extra non-allowlisted file, a commit by a non-bot author, a wrong base, and a red required check.
- [x] Which callers may use `--source-kind release` is defined in governance config (not a CLI flag the caller sets), defaulting to the operator and planner roles and denied for executor roles. The docs state plainly whether this caller restriction is a hook-level boundary or a mistake guard (see DEC-0038: a same-user CLI check is not a security boundary); the GitHub-derived PR checks above are the real control.
- [x] The governance hook's refusal message and the release section of CLAUDE.md name the new command, and CLAUDE.md no longer tells agents to arm release PRs with raw gh.
- [x] The merge is recorded in the audit/events log the CLI already writes for other kinds, with source kind `release` and the caller identity.
- [x] `gh-issue` remains refused and `backlog` behaviour is unchanged, covered by regression tests.
<!-- SECTION:DESCRIPTION:END -->
