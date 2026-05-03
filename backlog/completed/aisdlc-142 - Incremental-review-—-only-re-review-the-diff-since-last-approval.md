---
id: AISDLC-142
title: Incremental review — only re-review the diff since last approval
status: Done
assignee: []
created_date: '2026-05-02 22:13'
updated_date: '2026-05-02 23:58'
labels:
  - ci
  - cost-optimization
  - follow-up
  - review
dependencies:
  - AISDLC-141
references:
  - ai-sdlc-plugin/commands/execute.md
  - .github/workflows/ai-sdlc-review.yml
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists: orchestrator/src/runtime/attestations.ts
      (contentHashV3)
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Cost-optimization follow-up to AISDLC-140.** Today every push triggers full reviewer fan-out against `git diff origin/main...HEAD` (the entire PR diff). When a 200-line PR rebases or pushes a 5-line fix, reviewers re-read the same 200 lines.

## Proposed shape
- Store "last-reviewed contentHash" per PR. Use the existing `contentHashV3` (per-file blob delta hash) — already implemented at `orchestrator/src/runtime/attestations.ts`
- Storage: GitHub PR comment with marker `<!-- ai-sdlc:last-reviewed-contenthash:VALUE -->` (simplest; idempotent; visible in PR)
- On each push:
  - Compute current `contentHashV3`. Compare to last-reviewed.
  - If equal: skip review entirely (reuse prior approval signal — post `Post Review Results: success` directly per stale approval)
  - If changed: run reviewers against `git diff <last-reviewed-sha>...HEAD` (delta-only)
  - If diff is large (>200 lines OR touches new file types): fall back to full diff
  - After review: update the PR-comment marker with the new contentHash
- Composes with AISDLC-141 classifier — first decide which reviewers, then review only the delta

## Acceptance criteria
1. PR comment marker `<!-- ai-sdlc:last-reviewed-contenthash:... -->` written + updated per cycle
2. Reviewers receive only the delta diff (`git diff <last-reviewed-sha>...HEAD`) when delta is reasonable size
3. Skip-when-unchanged path: contentHash equal → no reviewer agents spawned, prior approval reused
4. Fall-back-to-full path: delta > N lines triggers full review
5. Composes correctly with AISDLC-141 classifier (classifier runs first, then incremental on the chosen subset)
6. Hermetic tests: rebase no-content-change → skip; small fix → delta-only review; large refactor → full review
7. ≥80% patch coverage

## Expected savings
60-80% on multi-push PRs (most PRs after rebase/fix iterations).
**Combined with AISDLC-141:** 70-95% total reduction in reviewer-agent invocations vs current baseline. Achieves AISDLC-74's original "halve CI cost" goal WITHOUT the attestation-as-gate complexity.</description>
<acceptanceCriteria>["PR comment marker for last-reviewed-contenthash", "Reviewers receive delta diff when delta is small", "Skip-when-unchanged: contentHash equal → no reviewers spawned", "Fall-back-to-full when delta > 200 lines or touches new file types", "Composes with AISDLC-141 classifier (subset + delta)", "Hermetic tests cover all paths", ">=80% patch coverage"]</acceptanceCriteria>
</invoke>
<!-- SECTION:DESCRIPTION:END -->
