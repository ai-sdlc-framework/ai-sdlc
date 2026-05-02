---
id: AISDLC-141
title: >-
  Wire conditional review classifier into Step 7 — drop unconditional 3-reviewer
  fan-out
status: Done
assignee: []
created_date: '2026-05-02 22:12'
labels:
  - ci
  - cost-optimization
  - follow-up
  - review
dependencies: []
references:
  - orchestrator/src/models/classifier.ts
  - ai-sdlc-plugin/commands/execute.md
  - .github/workflows/ai-sdlc-review.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Cost-optimization follow-up to AISDLC-140.** With attestation no longer providing the "skip duplicate review" shortcut, every push triggers the full 3-reviewer fan-out unconditionally. The conditional review classifier (RFC-0010 §12, AISDLC-70.3 — already built at `orchestrator/src/models/classifier.ts`) decides which subset of reviewers a given PR needs based on diff content + heuristics. It just needs WIRING into the actual review path.

## Existing surface
- `orchestrator/src/models/classifier.ts` — `decideFromRawOutput()`, `defaultRulesetDecision()`, `validateClassifierOutput()`, `ClassifierDecision` type. Confidence-gated (low-confidence falls open to all 3 reviewers per RFC-0010 Q4 resolution).
- `ai-sdlc-plugin/commands/execute.md` Step 7 — currently spawns code-reviewer + test-reviewer + security-reviewer unconditionally (3 parallel)
- `.github/workflows/ai-sdlc-review.yml` analyze job — same: spawns all 3 reviewers in CI

## Acceptance criteria
1. `/ai-sdlc execute` Step 7 invokes the classifier first; spawns ONLY the reviewers in `decision.reviewers`
2. Same wiring in `ai-sdlc-review.yml`'s analyze job — call classifier (CLI invocation), conditionally spawn subset
3. Fall-open behavior preserved: when `decision.fellOpen === true`, ALL 3 reviewers run (existing behavior)
4. Calibration log appended to `$ARTIFACTS_DIR/_classifier/calibration.jsonl` per existing scaffolding (already in classifier.ts)
5. Hermetic test: run a docs-only PR through the slash command; assert ZERO reviewers spawned (or just code-reviewer if classifier rules say so)
6. Hermetic test: run a code PR through; assert all 3 reviewers spawned
7. Cost-tracking signal: PR body includes "classifier decision: <reviewers>" so operator can see the savings vs the old default

## Out of scope (separate task)
- Incremental review (diff-since-last-approval) — AISDLC-142
- Codex/Opus model selection per reviewer — already handled by `modelOverride` field in ClassifierOutput; just plumb it through

## Expected savings
30-50% reduction in reviewer-agent invocations on a typical week (from skipping security on docs/non-touching PRs, skipping test on classifier-deemed-safe trivials, etc.)</description>
<acceptanceCriteria>["Step 7 invokes classifier; spawns only decided subset", "ai-sdlc-review.yml analyze job uses same classifier", "Fall-open preserved (all 3 reviewers when classifier confidence < 0.7)", "Calibration log appended to $ARTIFACTS_DIR/_classifier/calibration.jsonl", "Test: docs-only PR spawns 0 (or critic-only) reviewers per ruleset", "Test: code PR spawns all 3 reviewers", "PR body includes classifier decision text for visibility", ">=80% patch coverage"]</acceptanceCriteria>
</invoke>
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Wired RFC-0010 §12 conditional review classifier into Step 7 + ai-sdlc-review.yml analyze job. Replaces unconditional 3-reviewer fan-out with deterministic ruleset (docs-only → critic; lockfile/CI → security+critic; auth-touching → all 3 with opus bump; code → all 3). Failure modes fall open to ALL_REVIEWERS so safety preserved. ~30-50% expected reduction in reviewer-agent invocations.

## Verification
- 100% line/branch coverage on classifier.ts; 94% on classify-pr.ts (above 80% threshold)
- 3 reviews APPROVED — 0c/0M/2m/5s plus 2 LOW security findings filed as AISDLC-145 (downgrade vectors, not exploits)

## Follow-ups (deferred)
- AISDLC-145 (filed) — classifier hardening: docs-branch extension safelist + auth regex widening
- Code-reviewer: classifier docstring claims "byte-identical to orchestrator copy" but they've drifted (FellOpenReason + ClassifierDecision shape) — fix the docstring; consider consolidating the two copies once tier inversion is acceptable
- Code-reviewer suggestions: workflow `|| echo` fallback duplicates CLI fall-open contract; execute.md redundant sentence; case-builtin for subset match
<!-- SECTION:FINAL_SUMMARY:END -->
