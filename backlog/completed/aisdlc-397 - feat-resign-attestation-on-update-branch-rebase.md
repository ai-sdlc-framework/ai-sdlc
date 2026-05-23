---
id: AISDLC-397
title: 'feat(ci): re-sign attestation when merge-queue update-branch rebases a PR'
status: Done
labels: [ci, attestation, merge-queue, v4-kick]
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - CLAUDE.md
priority: high
permittedExternalPaths: []
---

## Description

When the merge-queue's update-branch step rebases an open PR onto fresh main, the rebased commits get new SHAs. The attestation envelope at HEAD is named for the pre-rebase SHA, so CI's `verify-attestation.yml` computes `contentHashV4 mismatch` against the post-rebase tree. The operator (or autonomous loop) then manually re-signs and force-pushes — only to have the next sibling-PR merge trigger another update-branch rebase, which invalidates the fresh envelope. PR #626 (AISDLC-373) hit this loop 3 times in the overnight 2026-05-23 session before being marked STUCK.

The fix: a GitHub Actions workflow that triggers on `pull_request.synchronize` events authored by the merge-queue (or detected via "HEAD SHA changed but operator did not push"), runs the signer in CI against the current HEAD using a CI-side signing key, commits the chore, and pushes back to the PR branch.

## Acceptance criteria

- [ ] AC-1: New workflow `.github/workflows/resign-attestation-on-rebase.yml` triggers on `pull_request.synchronize`, detects when the synchronize was caused by an update-branch operation (not an operator push), and re-signs the attestation envelope for the new HEAD SHA. Detection heuristic: `github.event.before` matches the previous attestation envelope name AND `github.event.after` does not have a matching envelope in the tree.
- [ ] AC-2: Workflow uses an ed25519 CI signing key stored as repo secret `AI_SDLC_CI_SIGNING_KEY` (PEM format). Public key added to `.ai-sdlc/trusted-reviewers.yaml` under a new entry `ci-resign-bot`.
- [ ] AC-3: Workflow commits the chore as `github-actions[bot]` with message `chore: re-sign attestation for AISDLC-N after merge-queue rebase` and pushes with `--force-with-lease`.
- [ ] AC-4: Workflow short-circuits + posts a comment on the PR if (a) no `.active-task` sentinel exists, (b) no verdict file exists at `.ai-sdlc/verdicts/<task-id-lower>.json`, or (c) the head commit is already a chore-sign commit (avoids infinite loop).
- [ ] AC-5: Hermetic test at `.github/workflows/resign-attestation-on-rebase.test.mjs` validating the detection heuristic with fixture envelope SHAs.
- [ ] AC-6: Documentation update in `CLAUDE.md` under "Review attestations" section explaining the new workflow + its interaction with the v4-kick recovery dance.
- [ ] AC-7: Operator action documented at the top of the workflow file: how to generate + rotate the CI signing key (`/ai-sdlc init-signing-key --ci` extension, OR manual `node ai-sdlc-plugin/scripts/init-signing-key.mjs --pem-only` + base64 + `gh secret set`).
- [ ] AC-8: Workflow respects `AI_SDLC_LEGACY_VERDICTS=1` flag when the verdict file is plain-JSON (ad-hoc reviewer mode).
- [ ] AC-9: Reference the PR #626 incident (2026-05-23) in the workflow comment header as the motivating bug.

## Why now

PR #626 (AISDLC-373) cycled 3 times overnight; #524 (AISDLC-284) is likely to hit the same; every future PR is exposed. The autonomous overnight loop wasted ~6 hours waiting on this; until this lands, every operator-away push that triggers a merge-queue rebase is at risk. Closes the systemic v4-kick failure mode.

## Out of scope

- Replacing v4/v5 with v6 (RFC-0042) — v6 has the same per-HEAD-SHA envelope naming, so v6 alone does NOT fix this. v6 cutover is tracked separately.
- Cross-PR coordination when multiple sibling PRs all need re-signing simultaneously (the queue serializes update-branch, so this shouldn't compound).
- Removing the merge-queue's update-branch step (operator decision; out of scope).

## References

- PR #626 STUCK comment: https://github.com/ai-sdlc-framework/ai-sdlc/pull/626#issuecomment-4524856673
- `feedback_v4_kick_recipe.md` operator memory (partially superseded post-AISDLC-395)
- CLAUDE.md "Review attestations" section
- AISDLC-380 (sub-attestation gate — still hard-fails on v5 envelope mismatches)

## Estimated effort

2-3 hours. Workflow + signing-key extension + hermetic test + docs.
