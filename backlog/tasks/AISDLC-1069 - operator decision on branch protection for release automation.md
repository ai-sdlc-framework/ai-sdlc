---
id: AISDLC-1069
title: 'operator decision: branch protection on main (enforce_admins) versus release automation that must land pins after a release'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - governance
  - release
  - rca-2026-10-23
priority: medium
dispatchable: false
dependencies: []
references:
  - .github/workflows/release.yml
  - docs/operations/release-flow.md
  - docs/operations/decision-authority.md
---

## Description

RCA 2026-10-23 (0.36.0 release). The release workflow's pin-sync job pushed `HEAD:main` and was rejected by branch protection (`GH006`, `enforce_admins` on). AISDLC-1059 changed the job to open a PR instead, which works but adds one PR and one gate run per release and leaves a window where `main` lags the registry (see the sibling task that moves the drift check off the per-PR gate). The underlying question is a repository setting and a trust-chain control, so it is class (c), operator-only, and this task is the record of the decision, not an implementation.

Options for the operator, to be run through the decision rubric and recorded in the Decision Catalog with `cli-file decision`:

- (a) Keep `enforce_admins` on and keep the PR path (status quo since the pin-sync job began opening a PR). No automation ever pushes to `main`; cost: one extra PR per release and the lag window.
- (b) Keep `enforce_admins` on and let release-please carry the pin bump inside the release PR itself (the `extra-files` or a pre-release step that rewrites the pins before the release PR merges), so no post-merge step is needed. Removes the lag window; needs the release PR to know the version before publish, which release-please does.
- (c) Grant the release workflow a bypass actor (GitHub ruleset bypass for the GitHub Actions app or a deploy key) so the sync job can push. Fastest; weakens the control that no automation writes to `main` unreviewed.

Recommended for the walkthrough: (b), because it deletes the post-merge job and the window without loosening a control. Record the choice as a decision (class (c), operator-answered), then file the implementation task for the chosen option. This task is `dispatchable: false`; it closes when the decision record is on `main`.

**Five-step review (requirements first).** Requirement questioned: must anything push to `main` after a release at all? Option (b) says no. Deletion candidate: the post-merge sync job. Simplified: one PR carries version and pins. Accelerated: no lag window. Automated last: release-please does it.

## Acceptance Criteria

- [ ] A decision record (class (c), operator-answered) is on `main` naming the chosen option with rationale and the rollback.
- [ ] The implementation task for the chosen option is filed and referenced from the decision record; `docs/operations/release-flow.md` names the decision.
- [ ] This task moves to `backlog/completed/` in the PR that lands the decision record.
