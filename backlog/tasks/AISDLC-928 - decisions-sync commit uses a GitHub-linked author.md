---
id: AISDLC-928
title: 'fix: decisions-sync commit uses a GitHub-linked author so the sanctioned landing path accepts it'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, decisions, governance, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/decisions/remote-persist.ts, pipeline-cli/src/governance/merge-if-eligible.ts, pipeline-cli/src/governance/merge-if-eligible.test.ts]
priority: high
dispatchable: true
---

## Description

`remote-persist.ts` writes the decision-catalog sync commit on `ai-sdlc/decisions-sync` with a synthetic identity (`user.name=ai-sdlc-decisions`, `user.email=decisions@ai-sdlc.invalid`). `merge-if-eligible` (the only sanctioned landing path) checks that the head commit author resolves to a GitHub login on `spec.governance.mergeAuthors`. An `.invalid` address resolves to no login, so every decisions-sync PR is refused with "the head commit author is not linked to a GitHub account — refusing (cannot be determined)". The `decisions-sync` source kind added for these PRs therefore can never land one; today PR #1594 (green, CLEAN) is stuck on it and only the operator's own identity can land it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the sync commit needs its own synthetic identity. It does not; the commit is produced by a session that already has a git identity, and an attributable author is what the trust check exists to verify. 2. Deleted: the two `-c user.name` / `-c user.email` overrides in `remote-persist.ts`. 3. Simplified: the sync commit inherits the committing session's configured git identity, like every other commit the sessions make; the author check in `merge-if-eligible` is unchanged (no exemption for decisions-sync). 4. Accelerated: decisions-sync PRs land through the normal path instead of waiting on the operator. 5. Automated: a test that the sync commit is authored by the configured identity, and a `merge-if-eligible` test that a decisions-sync PR whose head author is on the allow-list passes the author check.

If the configured identity is empty, `remote-persist` refuses to commit with a clear message instead of falling back to a synthetic one. The commit-author trust check is not loosened for any source kind.

## Acceptance Criteria

- [ ] The decisions-sync commit is authored and committed with the session's configured `user.name` / `user.email`; no `@ai-sdlc.invalid` identity remains in the code.
- [ ] With no configured identity, `remote-persist` refuses with a message naming the missing config and pushes nothing.
- [ ] A `merge-if-eligible` test shows a `decisions-sync` PR whose head author login is on `mergeAuthors` passes the author check; the existing unlinked-author refusal test still passes.
- [ ] `docs/operations/dispatched-session-decisions.md` states the commit identity used by the sync.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Observed 2026-10-15: landing PR #1594 with `--source-kind decisions-sync` refused on the unlinked author; head commit 6bae243c1 by `ai-sdlc-decisions <decisions@ai-sdlc.invalid>`. The current PR is landed by the operator.
