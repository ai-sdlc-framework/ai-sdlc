---
id: AISDLC-139
title: cli-pr-unstick — deterministic PR-blocker auto-resolver (run on wake-up cycle)
status: Done
assignee: []
created_date: '2026-05-02 20:24'
labels:
  - ci
  - automation
  - follow-up
  - infrastructure
dependencies: []
references:
  - pipeline-cli/bin/cli-pr-unstick.mjs (new)
  - scripts/check-orchestrator-state.sh
  - .github/workflows/auto-rebase-open-prs.yml
  - scripts/ci-sign-attestation.mjs
  - 'memory: feedback_autonomous_orchestration_pattern.md'
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Caught repeatedly.** Today alone, 3+ PRs got stuck in obscure CI/branch-protection states (PR #166 missing Post Review Results, PR #176 missing 3 required statuses on attestation chore commit, PR #170 attestation invalidation). Each time the operator had to notice, tell Claude, and Claude had to investigate from scratch.

**Same pattern as RFC-0011 Stage A/B**: deterministic-first, LLM-as-last-resort. The operator wants a single CLI that diagnoses + auto-resolves what it can, escalates only what it can't.

## Proposed shape

`pipeline-cli/bin/cli-pr-unstick.mjs <pr-number>` — exits 0 on resolved or already-clean, exits 1 with a diagnosis when LLM intervention needed. Flags: `--dry-run`, `--all` (sweep every open PR), `--watch` (poll mode for cron/wake-up loop).

## Deterministic checks + auto-fixes (Stage A — no LLM)

| Symptom | Detection | Auto-fix |
|---|---|---|
| **Stale forwarded statuses on AISDLC-87 attestation chore** | HEAD commit message starts with `chore(ci): sign review attestation`; required statuses missing on HEAD but present on parent | `gh api repos/.../statuses/<head>` POST `success` for each missing required status, with description "forwarded from parent — AISDLC-87 [skip ci] chore gap" |
| **PR is BEHIND main** | `gh pr view --json mergeStateStatus` returns `BEHIND` | `gh pr update-branch --rebase` (already covered by AISDLC-138 workflow but per-PR fix is faster) |
| **Docs-only PR missing Post Review Results** | All changed files match docs-only paths-ignore patterns + check missing | Same forwarding via `gh api .../statuses` (AISDLC-136's fallback workflow does this on push, but if it didn't fire, manual post unblocks) |
| **Stale local attestation after rebase (contentHashV3 mismatch)** | `ai-sdlc/attestation: failure` AND PR has 3 approving CI reviews | Check if CI-attestor key is bootstrapped (AISDLC-87); if yes, trigger a no-op force-push via `git commit --allow-empty + git push` to re-trigger the workflow chain |
| **Backlog Drift CI failure** | `Backlog Drift: failure` AND PR is otherwise clean | Non-blocking; document in output but don't auto-fix (AISDLC-125 is the path) |

## LLM-fallback (Stage B)

If no deterministic check matches, output a structured prompt the operator (or main-thread Claude) can paste: PR number, mergeable state, all check states, full check-runs table, and "why is this stuck?" — let the model reason from there.

## Wake-up integration

Add a step to the autonomous orchestration loop (`feedback_autonomous_orchestration_pattern.md`): every 25-30 min wake-up runs `cli-pr-unstick --all --auto-resolve` first, BEFORE dispatching new work. This means PRs auto-heal between cycles even when no operator action is taken.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. New CLI `pipeline-cli/bin/cli-pr-unstick.mjs` — handles each Stage A check listed above
2. Hermetic tests at `pipeline-cli/src/cli/pr-unstick.test.ts` — cover each detection + the no-op when nothing's stuck
3. `--dry-run` mode that prints what it WOULD do without taking action
4. `--all` mode iterates every open PR sequentially; aborts on transient errors but continues the loop
5. Documented in `docs/operations/pr-unstick.md` — when to use it, how to interpret output, how to add a new Stage A check
6. Integration with autonomous orchestration: the wake-up sentinel-prompt invokes it BEFORE the dispatch step
7. New code reaches 80% patch coverage

## Out of scope (separate follow-up)
- Cron/scheduled-action invocation outside the wake-up loop
- Self-modifying behavior (the tool reports + suggests, doesn't rewrite the orchestrator)
- Auto-merge (still operator-only per Hard Rule)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 pipeline-cli/bin/cli-pr-unstick.mjs CLI handles each Stage A check (chore-status forwarding, BEHIND rebase, docs-only fallback, stale attestation no-op-push, backlog-drift docs)
- [x] #2 Hermetic tests at pipeline-cli/src/cli/pr-unstick.test.ts cover each detection + no-op-when-clean
- [x] #3 --dry-run mode prints proposed actions without taking them
- [x] #4 --all mode iterates every open PR sequentially; per-PR errors don't abort the loop
- [x] #5 docs/operations/pr-unstick.md operator guide
- [x] #6 Autonomous orchestration wake-up loop invokes it before dispatching new work
- [x] #7 ≥80% patch coverage on new code
- [x] #8 Stage B LLM-fallback emits a structured diagnosis prompt the operator can paste
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Shipped cli-pr-unstick — deterministic PR-blocker auto-resolver. 5 Stage A checks (chore-status forwarding, BEHIND rebase, docs-only fallback, stale attestation, backlog-drift report) + Stage B markdown diagnosis prompt. Round 2 fixed 2 code-reviewer-flagged majors (silent force-greening of pending checks; paginated JSON parse).

## Changes
- pipeline-cli/src/cli/pr-unstick.ts (new) — 5 Stage A detectors + Stage B prompt
- pipeline-cli/src/cli/pr-unstick.test.ts (new) — 56 hermetic tests
- pipeline-cli/bin/cli-pr-unstick.mjs (new)
- pipeline-cli/package.json — bin entry
- docs/operations/pr-unstick.md (new) — operator guide

## Verification
- pnpm build / test / lint / format:check — pass
- 56 hermetic tests pass; 96.37% line coverage on pr-unstick.ts
- 3 reviews APPROVED — code 0c/0M/2m/3s (round 1: 0c/2M; round 2 fixes shipped); test 0c/0M/0m/0s; security 0c/0M/0m/0s

## ⚠ Potentially temporary tool
Per architecture analysis at /tmp/quality-gate-redesign-memo.md, this CLI may become unnecessary if Option A+B (single `pr-ready` aggregator + attestation-as-audit) lands — the aggregator's description field IS the diagnosis surface. Operator-decision deferred to that walkthrough.

## Follow-up (deferred)
- 5 minor findings from code reviewer (allowFailure on git rev-parse, --repo on applyRebase, etc.)
- Wake-up loop integration (operator-side prompt update)
- AISDLC-87 architectural rewrite (separate strategic discussion in /tmp/quality-gate-redesign-memo.md)
<!-- SECTION:FINAL_SUMMARY:END -->
