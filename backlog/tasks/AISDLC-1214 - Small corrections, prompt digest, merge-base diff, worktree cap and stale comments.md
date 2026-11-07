---
id: AISDLC-1214
title: 'Small corrections: prompt digest, merge-base diff, worktree cap and stale comments'
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - corrections
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - orchestrator/src/provenance.ts
  - orchestrator/src/validate-agent-output.ts
  - pipeline-cli/src/steps/00-worktree-disposition.ts
  - orchestrator/src/runtime/attestations.ts
priority: medium
dispatchable: true
---

## Description

**Source.** RFC-0062 Phase 1 item 7 and the Implementation Plan's stale-comment list. Affected surface: `orchestrator/src/provenance.ts` (prompt digest), `orchestrator/src/validate-agent-output.ts` (diff base), the worktree disposition step (`ceiling: 40` alarm), and four stale comments.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* Each item is a correctness or clarity fix the audits found; none adds a feature.
2. *Delete.* The signing and v3/v5 prose in `runtime/attestations.ts:1-72` that no longer describes the code.
3. *Simplify.* Store the full prompt digest and keep the 16-hex form as a display and grep key; diff against the merge base instead of `HEAD~1`; turn the worktree ceiling into a cap that evicts the oldest open-PR worktree by branch-head age.
4. *Accelerate.* None.
5. *Automate.* Tests for the three behaviour changes; the comment fixes are reviewed by reading.

## Scope of comment fixes
- `dogfood/scripts/ppa-score.ts:112` says 90 days where the code uses 180.
- `spec/dor-corpus/README.md:10-19` says 75 fixtures where 78 exist.
- `spec/rfcs/RFC-0019-*.md:30` body lifecycle disagrees with its frontmatter.
- `orchestrator/src/runtime/attestations.ts:1-72` describes signing and v3/v5 acceptance that RFC-0061 removed.

## Acceptance Criteria
- [ ] #1 Provenance blocks carry the full sha256 digest with the 16-hex prefix as a separate display field; existing grep keys still match.
- [ ] #2 `validate-agent-output` max-lines check diffs against the merge base; a two-commit branch fixture is measured in full.
- [ ] #3 At the cap, the disposition step evicts the oldest open-PR worktree by branch-head age and logs it; below the cap nothing changes.
- [ ] #4 The four comments are corrected and the RFC-0019 frontmatter and body agree.
