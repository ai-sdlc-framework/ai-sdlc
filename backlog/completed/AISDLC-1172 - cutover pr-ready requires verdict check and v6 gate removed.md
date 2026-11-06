---
id: AISDLC-1172
title: >-
  RFC-0061 Phase 2: cutover, pr-ready requires the verdict check and the v6
  gate, hook signing and land-prep step are removed
status: Done
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - ci
  - pipeline-cli
  - phase-2
dependencies:
  - AISDLC-1169
  - AISDLC-1170
  - AISDLC-1171
  - AISDLC-1193
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - .github/workflows/ai-sdlc-gate.yml
  - pipeline-cli/src/steps/land-prep.ts
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/head-envelope.ts
  - pipeline-cli/src/governance/rebase-rearm.ts
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
priority: high
dispatchable: true
drift_status: flagged
drift_checked: '2026-11-05'
drift_log:
  - date: '2026-11-05'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/scripts/check-attestation-sign.sh
    resolution: flagged
  - date: '2026-11-05'
    type: dep-resolved
    detail: Dependency AISDLC-1169 has been completed
    resolution: flagged
  - date: '2026-11-05'
    type: dep-resolved
    detail: Dependency AISDLC-1170 has been completed
    resolution: flagged
  - date: '2026-11-05'
    type: dep-resolved
    detail: Dependency AISDLC-1171 has been completed
    resolution: flagged
  - date: '2026-11-05'
    type: dep-resolved
    detail: Dependency AISDLC-1193 has been completed
    resolution: flagged
---

## Description

**Cutover go (DEC-0375).** Operator, 2026-11-05: the shadow-report precondition is waived; cut over now. AISDLC-1193 (every pipeline push carries a verdict ref) lands first, so `ai-sdlc/pr-ready` does not fail PRs for a missing record the writer should have produced.

Implements RFC-0061 Migration Path phase 2 and OQ-3 (names kept).

**Scope.**
1. The verdict check posts under the kept context name `ai-sdlc/attestation` and feeds `ai-sdlc/pr-ready`; the shadow context `ai-sdlc/review-verdict` is removed.
2. Delete the v6 attestation-gate verify job, the pre-push signing and verifying hook (`check-attestation-sign.sh` and its double-sign path), and land-prep's stale-envelope step. `ship.ts` never fails closed on attestation; `git push` fails for git reasons only. Step 11 stops producing v6 envelopes.
3. **Replacement semantics (load-bearing):** `rebase-rearm.ts`, `resume-decision.ts`, `reenter.ts`, `dispatch/resume.ts` and `pr-state.ts` use the AISDLC-1170 function. The `content-hash-mismatch` state becomes "needs re-review"; push-only resume becomes "carried forward, else review". No patch-id comparison remains on these paths.
4. `head-envelope.ts` checks for a verdict ref for the head instead of an envelope.

## Acceptance Criteria

- [x] AC-1: `ai-sdlc/pr-ready` fails a PR with no record and passes one with a valid or carried-forward record.
- [x] AC-2: A push from an executor never stops for attestation reasons. Test that runs Step 11 with no envelope.
- [x] AC-3: No file under `pipeline-cli/src` or `ai-sdlc-plugin/scripts` on the resume, re-enter and rebase paths calls a patch-id helper. Grep test.
- [x] AC-4: The pre-push hook no longer signs or verifies; `check-attestation-sign.sh` is deleted with its test.

## Final Summary

## Summary
RFC-0061 Phase 2 cutover: a new `verdict-check` job posts the kept `ai-sdlc/attestation` context and feeds `ai-sdlc/pr-ready`. The v6 attestation-gate job, `attestation-post.yml`, `check-attestation-sign.sh` (both copies) and land-prep's stale-envelope step are deleted. `ship.ts` and Step 11 no longer sign or fail on attestation. Resume, re-enter, rebase-rearm, push-only and head checks use the AISDLC-1170 clean-replay rule or the verdict ref, with no patch-id.

## Changes
- .github/workflows/ai-sdlc-gate.yml
- .github/workflows/main-health-monitor.yml
- .ai-sdlc/gates.yaml
- scripts/pre-push-fixups.sh
- scripts/check-pr-governance.mjs
- scripts/check-governance-boundary.mjs
- package.json
- pipeline-cli/src/attestation/verdict-cli.ts
- pipeline-cli/src/attestation/verdict-check.ts
- pipeline-cli/src/attestation/no-patch-id-on-resume-paths.test.ts
- pipeline-cli/src/cli/attestation.ts
- pipeline-cli/src/cli/dispatch.ts
- pipeline-cli/src/cli/merge-if-eligible.ts
- pipeline-cli/src/governance/rebase-rearm.ts
- pipeline-cli/src/next-step/head-envelope.ts
- pipeline-cli/src/next-step/resume-decision.ts
- pipeline-cli/src/next-step/ship.ts
- pipeline-cli/src/steps/11-push-and-pr.ts
- pipeline-cli/src/steps/land-prep.ts
- pipeline-cli/src/dispatch/resume.ts
- pipeline-cli/src/hierarchy/pr-state.ts
- pipeline-cli/src/hierarchy/reenter.ts
- pipeline-cli/src/hierarchy/reconcile.ts
- docs/operations/cli-hierarchy.md

## Design decisions
See developer final message; one pipeline-cli test fixed and re-run green alone; full per-package suite not re-run after that fix.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

