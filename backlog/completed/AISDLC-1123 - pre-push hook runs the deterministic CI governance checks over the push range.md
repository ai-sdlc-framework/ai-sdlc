---
id: AISDLC-1123
title: pre-push hook runs the deterministic CI governance checks (waived-tests, reviewers, attestation verify, backlog drift, conflict markers) over the push range, so a red that CI would raise is fixed before the push
status: Done
assignee: []
created_date: '2026-10-30'
labels:
  - ci
  - hooks
  - velocity
priority: high
references:
  - .husky/pre-push
  - scripts/check-pr-governance.mjs
  - scripts/verify-attestation.mjs
  - scripts/run-gate-tests.mjs
  - docs/operations/quality-gate.md
---

## Description

A token audit over 2026-10-23 to 2026-10-30 classified the 202 extra developer rounds of the week by root cause (report in the planner's audit, summary in this task). Half were infrastructure (stale-worker reaps, hierarchy holds) and are addressed by other tasks. 29 rounds, plus two PRs still red on 2026-10-30, came from deterministic checks that CI runs and the local hooks do not: the `waived-tests` marker in a completed task file (9 rounds), the `reviewers` governance check (4), an attestation `contentHashV4 mismatch` (4, two more as co-cause), backlog drift (3, one pending), a `test:gates` failure never run locally (4), conflict markers and markdown formatting (2). Every one of these costs a CI run, a reenter, a developer round and a review round, each on a model, for a fix that takes a minute in the worktree that still has the developer.

Every `waived-tests` red came from a run that died before Step 10 and was then lease-pushed by hand, so a finalize-time check (AISDLC-1056) does not see it. The pre-push hook is the one place every push passes through, executor or human. AISDLC-1119 adds the patch-coverage check to the same hook; this task adds the rest of the deterministic set and nothing else.

**Five-step review (requirements first).** Requirement questioned: does a local copy of the governance checks create a second standard next to CI? No: the hook calls the same scripts with the same arguments CI passes, and CI stays the only gate that blocks a merge. Deletion: nothing to delete in the hook; the task deletes the by-hand habit of pushing a half-finished run without the finalize checks. Simplified: one new hook step per script, each a single command over `merge-base..HEAD`, no new logic. Accelerated: the red moves from after a CI run and a reenter to before the push. Automated: every push from every worktree runs it, with no prompt rule to remember.

## Fix

1. `.husky/pre-push`, after the existing fixups step (so the signed, squashed HEAD is what is checked) and before the patch-coverage step from AISDLC-1119:
   - `BASE=$(git merge-base HEAD origin/main)`; a missing `origin/main` skips the whole block with one line.
   - `node scripts/check-pr-governance.mjs waived-tests --base "$BASE" --head HEAD` and `node scripts/check-pr-governance.mjs reviewers --base "$BASE" --head HEAD`, with the same docs-only exemption CI applies (the script decides; the hook only passes the shas).
   - `node scripts/verify-attestation.mjs` over the envelope for HEAD when the push range contains an attestation envelope (public keyring only; the script is not modified, it is a blocked path).
   - `npx backlog-drift check` only when the push range adds, renames or deletes a file referenced from `backlog/` (cheap `git diff --name-status` filter first).
   - `git diff "$BASE" HEAD --check` for conflict markers; `prettier --check` over the changed `*.md` files.
   - `node scripts/run-gate-tests.mjs` when the range touches `ai-sdlc-plugin/`, `scripts/` or `.github/workflows/`; untouched otherwise.
   - One skip variable `AI_SDLC_SKIP_GOVERNANCE_GATE=1`, logged in the hook's existing skip line, documented in the header; the pre-push discipline rule (never routine) applies.
2. `docs/operations/quality-gate.md`: one paragraph listing which CI checks also run at pre-push and that CI alone blocks a merge.

## Velocity impact

Adds a few seconds per push (the governance scripts are static scans; the gate tests run only when their inputs changed). Removes, per caught PR, a CI run, a reenter, a developer round and a review round. The week's count is 29 to 35 rounds.

## Acceptance Criteria

- [x] A push whose completed task file carries a `waived-tests` marker is refused with the script's own message; removing the marker makes the same push pass.
- [x] A push whose attestation envelope no longer matches HEAD's content hash is refused by the verify step.
- [x] A push that deletes a file referenced from `backlog/` is refused with the drift report; a push touching no referenced file does not run drift.
- [x] A docs-only push runs neither the gate tests nor the reviewers check beyond the script's own exemption.
- [x] A conflict marker left in any file refuses the push.
- [x] The hook header lists the new step and its skip variable; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Out of scope

- The patch-coverage step (AISDLC-1119) and rebuild after rebase (AISDLC-1111).
- Any change to the scripts' thresholds or to `scripts/verify-attestation.mjs`.

## Final Summary

## Summary
Added scripts/check-governance-on-push.sh and wired it as the last step of .husky/pre-push. It runs the CI governance checks over the push range: conflict markers, waived-tests, reviewers, backlog drift, and gate tests. Attestation verify already runs in the fixups step. The header and quality-gate.md document the step and its skip variable, AI_SDLC_SKIP_GOVERNANCE_GATE.

## Changes
- .husky/pre-push
- scripts/check-governance-on-push.sh
- scripts/check-governance-on-push.test.mjs
- docs/operations/quality-gate.md
- backlog/tasks/AISDLC-1123 - pre-push hook runs the deterministic CI governance checks over the push range.md

## Design decisions
Verification ran `pnpm build && pnpm test && pnpm lint && pnpm format:check` and exited 0. I did not read the summary line, so it is not quoted here. The new test file (6 tests) passed on its own. The hook ran green on the push. Lint-staged cleared the executable bit on the new script at first commit, so I restored it with `git update-index --chmod=+x` and amended. AC2 (attestation mismatch) relies on the existing verify step in check-attestation-sign.sh, reached through pre-push-fixups.sh. The new script does not call it again.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

