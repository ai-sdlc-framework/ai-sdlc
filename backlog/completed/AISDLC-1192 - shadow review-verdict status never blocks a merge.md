---
id: AISDLC-1192
title: Shadow review-verdict status never blocks a merge
status: Done
assignee: []
created_date: '2026-11-05'
labels:
  - rfc-0061
  - attestation
  - ci
  - fix
dependencies: []
references:
  - pipeline-cli/src/attestation/verdict-cli.ts
  - .github/workflows/ai-sdlc-gate.yml
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: high
dispatchable: true
drift_log:
  - date: '2026-11-05'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      pipeline-cli/src/attestation/verdict-catches.ts
    resolution: flagged
drift_checked: '2026-11-05'
---

## Description

**Source.** Operator in the planner session, 2026-11-05: #2331 and #2379 would not merge; the shadow check added by AISDLC-1169 is blocking merges.

**Today.** The `review-verdict-shadow` job in `ai-sdlc-gate.yml` runs `cli-attestation verdict-check --post-status`. `verdict-cli.ts:71` posts `ai-sdlc/review-verdict` with `state=failure` whenever the reason code is not ok (for example `no-record`). The context is not required on `main` (required: `Backlog Drift`, `ai-sdlc/pr-ready`), but a failing commit status makes GitHub report `mergeStateStatus: UNSTABLE`, and `cli-merge-if-eligible` and the hierarchy reconcile (`hierarchy/reconcile.ts:226,267`, `hierarchy/pr-state.ts:206`) require `CLEAN`. RFC-0061 Phase 1 says the shadow check never gates a merge; in practice it gates every dispatch merge. #2379 landed only through GitHub auto-merge.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the shadow status exists only to record agreement with v6 for the catch report; it must never affect mergeability. 2. Deleted: the failure state from the shadow post. 3. Simplified: one state for every reason code; the reason stays in the description and the catch ledger. 4. Accelerated: none. 5. Automated: test below.

1. `verdict-cli.ts` posts `state=success` for every reason code while the context is `ai-sdlc/review-verdict` (shadow). The description keeps the reason code (`shadow: no-record ...`), so the catch report and humans still see it.
2. `verdict-catches.ts` reads the reason code from the description (or from the ledger) instead of the state, so the catch report keeps classifying disagreements. Adjust only if it reads `state` today.
3. AISDLC-1172 removes this context at cutover; this fix is the bridge until then.

## Acceptance Criteria

- [x] AC-1: `verdict-check --post-status` with reason `no-record` posts `success` with the reason code in the description. Test with an injected runner.
- [x] AC-2: A non-ok reason never produces `failure` or `error` on `ai-sdlc/review-verdict`. Test across all reason codes.
- [x] AC-3: The catch report still counts disagreements correctly from the new post shape. Test.
- [x] AC-4: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Verification

Command: `pnpm build && pnpm test && pnpm lint && pnpm format:check` (exit 0). Targeted: `npx vitest run src/attestation/verdict-check.test.ts` in pipeline-cli: `Tests  18 passed (18)`.

## Final Summary

## Summary
The `ai-sdlc/review-verdict` shadow status now always posts `success`, with the reason code leading the description, so it no longer makes merges report UNSTABLE. The catch report now derives pass or fail from that reason code. It still treats old `failure` or `error` states as failed.

## Changes
- pipeline-cli/src/attestation/verdict-cli.ts
- pipeline-cli/src/attestation/verdict-catches.ts
- pipeline-cli/src/attestation/verdict-check.test.ts
- backlog/tasks/AISDLC-1192 - shadow review-verdict status never blocks a merge.md

## Design decisions
The PR is a draft. The new tests cover no-record, subject-mismatch, replay-dirty, coverage-short and tier-short through an injected runner. They also check that the catch report counts catches and disagreements from the new always-success post shape. The task file records the test command and the targeted summary line `Tests  18 passed (18)`. The pre-push hook's patch-coverage gate ran on the push, and the push went through.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

