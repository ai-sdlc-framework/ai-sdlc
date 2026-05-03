---
id: AISDLC-152
title: >-
  Find and remove remaining CI-attestor wiring — stop stale bot chore
  commits from deadlocking PRs (post-AISDLC-140)
status: Done
assignee: []
created_date: '2026-05-02 19:30'
labels:
  - ci
  - cleanup
  - deps
dependencies:
  - AISDLC-87
  - AISDLC-140
references:
  - .github/workflows/ai-sdlc-review.yml
  - pipeline-cli/src/incremental-review/incremental.ts
  - orchestrator/src/cli/commands/init-features.ts
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/commands/execute.md
  - scripts/check-skip-ci-marker.sh
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After AISDLC-140 sub-4 (PR #183) removed the CI-side attestor signing step from `.github/workflows/ai-sdlc-review.yml`, `chore(ci): sign review attestation [skip ci]` commits authored by `ai-sdlc-ci-attestor[bot]` were STILL being pushed to PR branches. These commits contain the literal `[skip ci]` token in the body, which suppresses every workflow on the new HEAD SHA, deadlocking PRs (required checks never post → branch protection blocks → operator has to manually retrigger).

Confirmed instances within the last 24 hours:
- PR #181 — chore commit author_date 2026-05-02T17:58:15Z, committer_date 2026-05-03T00:12:52Z (replayed via auto-rebase)
- PR #182 — same pattern

### Investigation findings

**Root cause is NOT a still-active attestor workflow.** The chore commits in PR #181 / #182 have an `author_date` from BEFORE AISDLC-140 sub-4 landed and a `committer_date` later — classic auto-rebase replay of a commit that lives in the branch's history. AISDLC-140 sub-4 (commit 9e4a02e) already removed the actual signing step from `ai-sdlc-review.yml`. No workflow file in `.github/workflows/` is signing attestations or pushing chore commits anymore.

**What WAS still wired (and removed in this task):**
1. `.github/workflows/ai-sdlc-review.yml:263` — analyze job's `gh pr view --jq` filter trusted `ai-sdlc-ci-attestor` author for the incremental-review marker comment
2. `.github/workflows/ai-sdlc-review.yml:925-926` — report job's `TRUSTED_LOGINS` Set included `ai-sdlc-ci-attestor` + `ai-sdlc-ci-attestor[bot]`
3. `pipeline-cli/src/incremental-review/incremental.ts:217-218` — `TRUSTED_MARKER_AUTHOR_LOGINS` Set included both bot login flavors (defense-in-depth Layer 1 for AISDLC-142)
4. `pipeline-cli/src/incremental-review/incremental.test.ts:507-547` — tests asserting bot was trusted
5. `ai-sdlc-plugin/commands/execute.md:314,329,483` — slash-command body's `gh pr view --jq` filters
6. `orchestrator/src/cli/commands/init-features.ts:553-554` — adopter `ai-sdlc init` next-steps STILL told new users to `gh secret set AI_SDLC_CI_ATTESTOR_PRIVATE_KEY` (prescriptive cruft pointing at a now-defunct flow)
7. `orchestrator/src/cli/commands/init-features.test.ts:452` — test asserting init prints the secret-set instruction
8. `orchestrator/src/cli/commands/init-workspace.test.ts:506` — test asserting init prints the secret-set instruction
9. `ai-sdlc-plugin/agents/developer.md:34` + `ai-sdlc-plugin/commands/execute.md:35` — Hard Rule 7 wording referenced "verify-attestation, ai-sdlc-review, and CI-side attestor" + "the AISDLC-87 CI-side attestor's own ... commit"

**What was KEPT (intentional defensive in-flight cleanup):**
- `pipeline-cli/src/cli/pr-unstick.ts:50` — `CI_ATTESTOR_SUBJECT_PREFIX` and `detectChoreStatusForwarding` (forwards required statuses for old chore commits in branch history that auto-rebase replays — AISDLC-139)
- `scripts/check-skip-ci-marker.sh:91-102` — bot-author + subject exemption (so historical chore commits can still be pushed without being rejected at pre-push). Comments updated to clarify this is now a defensive in-flight measure, not a producer/consumer of new bot activity.
- `pipeline-cli/src/cli/pr-unstick.test.ts` — tests for the above

### Out-of-band operator action items

These can ONLY be performed by a maintainer via the GitHub UI / `gh` CLI (cannot be automated from a worktree commit):

1. **Revoke the GH Secret**: `gh secret delete AI_SDLC_CI_ATTESTOR_PRIVATE_KEY --repo ai-sdlc-framework/ai-sdlc` — the secret is now unreferenced by any workflow, so revoking eliminates the leak surface entirely.
2. **Uninstall the GitHub App**: open repo Settings → GitHub Apps → uninstall `ai-sdlc-ci-attestor[bot]` (if installed). Without the app, the bot identity cannot push commits at all.
3. **(Optional) Trim `.ai-sdlc/trusted-reviewers.yaml`**: if any `ci-attestor` entry is present, remove it. Until removed, the verifier (`scripts/verify-attestation.mjs`) still trusts envelopes signed by that key — a maintainer-leaked private key would still sign a valid envelope. Removal invalidates any in-flight envelopes signed by the bot key (which should be zero post-AISDLC-140), so check the `.ai-sdlc/attestations/` directory first. THIS TASK INTENTIONALLY DID NOT MODIFY `.ai-sdlc/trusted-reviewers.yaml` per the operator-decision constraint.

## Acceptance criteria

1. Identify ALL remaining references to the CI-attestor (file paths + line numbers) — done; documented above
2. Categorize each: REACHABLE (still wired) vs DEAD (orphaned code) — done; nine REACHABLE items removed, three DEAD-defensive items intentionally retained for in-flight branch hygiene
3. Remove all REACHABLE wiring (workflow steps, env blocks, secret references in jobs) — done
4. Remove the dead-code references too (no value in keeping orphans) — done for adopter-facing scaffolding (init-features.ts); kept the in-flight defensive code (pr-unstick + check-skip-ci-marker) since old chore commits still live in branch history of in-flight PRs
5. Document for the operator (in PR body) any out-of-band cleanup they need to do — done; three action items above
6. Verify post-removal: `grep -rn "ci-attestor|ci-sign-attestation|AI_SDLC_CI_ATTESTOR" .github/ scripts/` returns ONLY commented historical references, no active wiring — done; all remaining matches are either AISDLC-152 self-citations explaining what was removed, or the defensive in-flight bot-author exemption with updated comments
7. Did NOT modify `.ai-sdlc/trusted-reviewers.yaml` — confirmed; left to operator decision

## Out of scope

- Modifying `.ai-sdlc/trusted-reviewers.yaml` (operator decision per task brief — would invalidate any in-flight envelopes signed by the bot key)
- Touching `.husky/**` or other governance directories
- Removing `pr-unstick.ts` `chore-status-forwarding` logic — still needed defensively for in-flight PRs whose branches contain old chore commits replayed via auto-rebase
- Removing `scripts/check-skip-ci-marker.sh` bot-author exemption for the same reason
- Sibling-repo cleanup (no `permittedExternalPaths` on this task)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Investigated the ongoing `chore(ci): sign review attestation [skip ci]` commits in PRs #181/#182 and confirmed AISDLC-140 sub-4 already removed the actual signing workflow. The chore commits showing up are OLD commits being replayed via auto-rebase (author_date predates AISDLC-140; committer_date is later). Removed the remaining REACHABLE CI-attestor wiring (workflow trust filters, incremental-review allowlist, adopter init scaffolding, hard-rule wording) and updated comments on the defensive in-flight cleanup logic (pr-unstick + check-skip-ci-marker). Kept the defensive cleanup itself because in-flight branches still carry historical chore commits that need to be pushable + status-forwardable until they cycle through.

## Changes
- `.github/workflows/ai-sdlc-review.yml` (modified): removed `ai-sdlc-ci-attestor` from analyze-job's `gh pr view --jq` filter (lines 258-275) and from report-job's `TRUSTED_LOGINS` Set (lines 922-928); replaced with explanatory AISDLC-152 comments.
- `pipeline-cli/src/incremental-review/incremental.ts` (modified): removed `ai-sdlc-ci-attestor` + `ai-sdlc-ci-attestor[bot]` from `TRUSTED_MARKER_AUTHOR_LOGINS`; updated docblock to explain the AISDLC-152 removal.
- `pipeline-cli/src/incremental-review/incremental.test.ts` (modified): inverted the two ai-sdlc-ci-attestor trust assertions to regression guards (now asserts the bot is NOT in the allowlist + a comment is filtered out).
- `ai-sdlc-plugin/commands/execute.md` (modified): removed `ai-sdlc-ci-attestor` from BOTH `gh pr view --jq` filters (Step 7a-bis read + Step 7c-bis idempotent comment update); updated Hard Rule 7 wording to clarify the attestor was retired.
- `ai-sdlc-plugin/agents/developer.md` (modified): updated Hard Rule 7 to drop "and CI-side attestor" from the workflow-suppression description and clarified the historical-commit exemption is defensive.
- `orchestrator/src/cli/commands/init-features.ts` (modified): removed the 3-line "Optional CI-side signer" block that told new adopters to `gh secret set AI_SDLC_CI_ATTESTOR_PRIVATE_KEY`. New adopters no longer get steered toward a defunct flow.
- `orchestrator/src/cli/commands/init-features.test.ts` (modified): inverted the secret-instruction assertion to a regression guard.
- `orchestrator/src/cli/commands/init-workspace.test.ts` (modified): same — secret-instruction assertion is now a regression guard.
- `scripts/check-skip-ci-marker.sh` (modified): updated header + inline comments to reflect the AISDLC-87 CI-attestor was retired (AISDLC-140 sub-4 + AISDLC-152) and the exemption is now a defensive in-flight measure, not a wired feature.

## Design decisions
- **Kept `pr-unstick.ts` chore-status-forwarding**: defensive remediation for in-flight PRs whose branches contain old chore commits replayed via auto-rebase. Removing it would re-introduce the deadlock the AISDLC-139 task was meant to fix.
- **Kept `scripts/check-skip-ci-marker.sh` bot-author exemption**: same in-flight rationale — without the exemption, an operator pulling main into a feature branch and re-pushing would be rejected at pre-push for carrying a stale chore commit.
- **Did NOT touch `.ai-sdlc/trusted-reviewers.yaml`**: per the task brief — that's an operator decision because it would invalidate any in-flight envelopes legitimately signed by the bot key (which should be zero post-AISDLC-140 but worth checking). Documented as out-of-band action item in the PR body.
- **Updated comments instead of deleting orphaned defensive code**: future readers need to know WHY the defensive logic exists (and when it can be deleted). Comment is the cheapest way to keep that context fresh.
- **Did not touch CHANGELOG.md historical entries**: those are point-in-time records of what shipped at the AISDLC-87/88 timestamps; rewriting them would falsify history.

## Verification
- `pnpm build` — clean (all workspace packages built)
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1002/1002 tests pass (incremental-review tests reflect the new no-bot-trust state)
- `pnpm --filter @ai-sdlc/orchestrator test` — 2995/2995 tests pass
- `node --test scripts/check-skip-ci-marker.test.mjs` — 18/18 pass (defensive exemption still works for historical commits)
- `node --test scripts/verify-attestation.test.mjs` — 62/62 pass
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Final post-removal grep: `grep -rn "ci-attestor|ci-sign-attestation|AI_SDLC_CI_ATTESTOR" .github/ scripts/` returns only AISDLC-152 self-citation comments + the defensive `check-skip-ci-marker.sh` exemption (with updated context comments). No active wiring remains.

## Follow-up
- **Operator action items** (out-of-band, listed in PR body): revoke `AI_SDLC_CI_ATTESTOR_PRIVATE_KEY` GH Secret, uninstall `ai-sdlc-ci-attestor[bot]` GitHub App, optionally remove `ci-attestor` entry from `.ai-sdlc/trusted-reviewers.yaml`.
- **Future cleanup task** (deferred until in-flight PRs cycle through): once no open PR branch contains a `chore(ci): sign review attestation` commit, the defensive `pr-unstick.ts` `chore-status-forwarding` detector + `scripts/check-skip-ci-marker.sh` bot-author exemption can be deleted entirely. Today they're load-bearing for in-flight branches.
<!-- SECTION:FINAL_SUMMARY:END -->
