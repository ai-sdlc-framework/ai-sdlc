---
id: AISDLC-1192
title: 'Shadow review-verdict status never blocks a merge'
status: To Do
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
  - pipeline-cli/src/attestation/verdict-catches.ts
  - .github/workflows/ai-sdlc-gate.yml
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: high
dispatchable: true
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

- [ ] AC-1: `verdict-check --post-status` with reason `no-record` posts `success` with the reason code in the description. Test with an injected runner.
- [ ] AC-2: A non-ok reason never produces `failure` or `error` on `ai-sdlc/review-verdict`. Test across all reason codes.
- [ ] AC-3: The catch report still counts disagreements correctly from the new post shape. Test.
- [ ] AC-4: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.
