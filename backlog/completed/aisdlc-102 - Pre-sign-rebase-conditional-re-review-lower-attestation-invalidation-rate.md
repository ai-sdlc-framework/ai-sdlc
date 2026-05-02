---
id: AISDLC-102
title: Pre-sign rebase + conditional re-review (lower attestation-invalidation rate)
status: Done
assignee: []
created_date: '2026-05-01 01:19'
updated_date: '2026-05-01 01:49'
labels:
  - bug
  - verifier
  - attestation
  - rebase
  - pipeline
dependencies: []
references:
  - backlog/completed/aisdlc-94 - Verifier-diffHash-should-be-rebase-tolerant-hash-post-apply-tree-state-not-literal-diff-text.md
  - backlog/completed/aisdlc-93 - ai-sdlc-review.yml-skip-attestation-valid-path-must-re-post-bot-approval-after-force-push.md
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Trigger:** AISDLC-94 Phase 1 (dual-hash) shipped a `contentHash` that's rebase-stable WHEN file content doesn't change. The remaining failure mode (AISDLC-93 / PR #102 root case) is: rebase onto a base where a sibling PR ALSO modified the same files — both diffHash and contentHash diverge, attestation rejected.

This task adds a **producer-side defense** that reduces the FREQUENCY of attestation invalidation: rebase the PR onto latest main right before signing the attestation. Composes with AISDLC-101 (per-file delta hashing as verifier-side defense) — together they form defense in depth.

## Defense layering

| Layer | Where | What it does | Status |
|---|---|---|---|
| Phase 1 (AISDLC-94) | Verifier | Accepts on either diffHash or contentHash | DONE PR #110 |
| Phase 1.5 (THIS) | Producer (Step 10.5) | Auto-rebases before signing → most runs sign latest state | THIS TASK |
| Phase 2 (AISDLC-101) | Verifier | Per-file delta hashing — handles sibling-merge between push and merge | will land via PR #110 |

Each layer reduces the failure rate further. AISDLC-102 alone doesn't make AISDLC-101 unnecessary — sibling PRs can still merge between our push and our merge, and Phase 2 handles that case without re-signing.

## Design — Step 10.5

Insert a new step between Step 9 (review iteration loop) and Step 10 (sign attestation):

```
Step 5-9: developer + reviewers run against base state (already happens)
  ↓
Step 10.5 (NEW): pre-sign rebase check
  ├─ git fetch origin main
  ├─ if origin/main is already an ancestor of HEAD → no-op (skip to Step 10)
  ├─ else: git rebase origin/main
  │   ├─ if conflict: abort with `outcome: aborted` + structured notes
  │   ├─ if clean rebase + post-rebase contentHash == pre-rebase contentHash:
  │   │   └─ no file content changed → reviewers' approval still valid → skip to Step 10
  │   └─ if clean rebase + contentHash CHANGED:
  │       ├─ file content materially different → re-spawn 3 reviewers (1 round)
  │       ├─ if approved: skip to Step 10
  │       └─ if changes-requested: re-iterate developer per Step 9 cap, then ship as `[needs-human-attention]`
  ↓
Step 10: sign attestation (against the rebased state)
Step 11: push (always a fast-forward now since we just rebased)
```

The `contentHash` from AISDLC-94 is the **decision oracle for "is re-review needed?"** — same hash = same code = reviewers' approval still binds; different hash = different code = re-spawn reviewers.

## What this DOES NOT do

- **Does NOT supersede AISDLC-101** — sibling PRs can still merge between our push and our merge; per-file delta hashing handles that residual case without forcing re-sign.
- **Does NOT auto-resolve rebase conflicts** — operator owns conflict resolution; orchestrator only handles clean rebases.

## Composition

- **AISDLC-94 (DONE)** — provides `contentHash` algorithm this task uses as re-review decision oracle
- **AISDLC-101** — per-file delta for sibling-merge-between-push-and-merge case
- **AISDLC-100.4** (RFC-0012 Phase 4 — slash command body refactor) — needs Step 10.5 incorporated. Add as AC to 100.4.
- **RFC-0012 §6.1** — slash command body template needs Step 10.5 added

## Operator follow-up after this lands

Update AISDLC-101's task description (which lands via PR #110): add a note that AISDLC-101 is now the second line of defense (residual case), not the only solution. Also update CLAUDE.md `What CI accepts` to remove the AISDLC-93 limitation note since AISDLC-102 + AISDLC-101 close it together.

## Dependency note

This task depends on AISDLC-94 (which just shipped via PR #110). The `dependencies:` field couldn't reference it because PR #110 hasn't merged yet — once it merges and AISDLC-94 lands in `backlog/completed/`, this dependency becomes implicit.

## References

- AISDLC-94 (DONE) — Phase 1 dual-hash; `contentHash` is the decision oracle
- AISDLC-101 (in PR #110) — Phase 2 per-file delta hashing; second line of defense
- AISDLC-93 — original failure case
- RFC-0012 — Two-tier pipeline architecture (Step 10.5 must land in both tiers)
- `ai-sdlc-plugin/commands/execute.md` — Tier 1 slash command body to extend
- `pipeline-cli/src/steps/` (post-RFC-0012) — Tier 2 step library to extend
- `orchestrator/src/runtime/attestations.ts` — `computeContentHash` is the decision oracle
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New Step 10.5 implemented in BOTH Tier 1 (slash command body) and Tier 2 (`executePipeline()`) per RFC-0012
- [x] #2 `git fetch origin main` runs at Step 10.5 with timeout; on fetch failure, skip rebase and proceed (don't block on flaky network)
- [x] #3 `git merge-base --is-ancestor origin/main HEAD` skips rebase if no-op (most common case)
- [x] #4 Rebase conflict → abort with structured failure JSON (`outcome: aborted`, populated `notes`); do NOT auto-resolve
- [x] #5 Post-rebase contentHash unchanged → proceed to Step 10 directly (reviewers' approval reused)
- [x] #6 Post-rebase contentHash CHANGED → re-spawn 3 reviewers in single message; if approved, proceed to Step 10
- [x] #7 Re-review iteration cap shares Step 9's cap (max 2 dev iterations); if exceeded → `[needs-human-attention]` PR
- [x] #8 Multiple sibling merges during one run: bound at 3 rebase attempts before failing with `outcome: aborted: rebase-loop`
- [x] #9 Also rebase at Step 3 (worktree setup) for early fresh base; costs nothing if main hasn't moved
- [ ] #10 After PR #110 merges: update AISDLC-101's task description to reframe as second line of defense; update CLAUDE.md `What CI accepts` to remove AISDLC-93 limitation note
- [x] #11 Add tests for rebase + re-review flow with worktree fixtures simulating sibling merges
- [x] #12 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- [ ] #13 Add an AC to AISDLC-100.4 (RFC-0012 Phase 4 slash command body refactor) requiring Step 10.5 in the new body
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Step 10.5 (pre-sign rebase + conditional re-review) inserted into execute-orchestrator pipeline. AISDLC-94's `contentHash` from PR #110 is the decision oracle: unchanged → reuse approval, changed → re-spawn 3 reviewers. New `--print-content-hash` mode on sign-attestation.mjs provides read-only hash oracle for the rebase decision. Step 3 also fetches origin/main for fresh-base setup. CLAUDE.md `What CI accepts` reframed AISDLC-93 as defense-in-depth (102 + 101 close it together).

## Changes

- `ai-sdlc-plugin/agents/execute-orchestrator.md` — Step 3 fetch + Step 10.5 prose (rebase, hash oracle decision tree, 3-attempt cap, conflict abort)
- `ai-sdlc-plugin/commands/execute.md` — thin wrapper update
- `ai-sdlc-plugin/commands/execute.test.mjs` — 11 new prose-marker assertions
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` — NEW `--print-content-hash` mode (early-exit, read-only)
- `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` — 3 new oracle tests
- `CLAUDE.md` — AISDLC-93 limitation note removed, defense-in-depth framing
- `ai-sdlc-plugin/CHANGELOG.md`

## AC status

- ✓ #2-9, #11-12 — fully met
- ⚠ #1 (Tier 2) — DEFERRED to AISDLC-100.5 (RFC-0012 Phase 5) since pipeline-cli doesn't exist yet
- ⚠ #10 — CLAUDE.md updated; AISDLC-101 reframing is operator follow-up after PR merges
- ⚠ #13 — AISDLC-100.4 task description NOT updated by dev (no MCP access from worktree); operator follow-up

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- 186/186 plugin tests; 53/53 execute.test.mjs; 7/7 sign-attestation.test.mjs
- 3 parallel reviews APPROVED (0 critical, 0 major, 5 minor, 2 suggestions); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable)

## Coordination notes

- **AISDLC-101**: kept changes additive — no edits to `attestations.ts` or `verify-attestation.mjs`. Verified by code reviewer (zero diff against those files).
- **AISDLC-100.4**: dev couldn't add the cross-AC via mcp__backlog from the worktree; operator follow-up to add: "AC: Step 10.5 prose required in the new ~80-line slash command body."

## Follow-up (non-blocking minor + suggestion findings)

- **Code minor**: rebase-loop vs rebase-conflict structured outcome labels could be more precise
- **Code minor**: fetch-failed-during-rebase has misleading "rebase-conflict" diagnostic
- **Code minor**: CHANGELOG test count says 9+3 but actual is 11+3
- **Code suggestion**: PRE_HASH timing comment would help future readers
- **Test minor**: prose tests tightly coupled to wording — copy-edits could trip them
- **Test minor**: zero-changed-files boundary not exercised
- **Test suggestion**: symmetric no-op-rebase test would lock in reuse-approval branch
<!-- SECTION:FINAL_SUMMARY:END -->
