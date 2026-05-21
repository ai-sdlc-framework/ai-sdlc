---
id: AISDLC-383.5
title: 'feat(hooks): bypass-all-gates env var for friction relief during RFC-0042 cutover'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - friction-reduction
  - hooks
parentTaskId: AISDLC-383
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - scripts/check-coverage.sh
  - scripts/check-task-moved.sh
  - scripts/check-dor-gate.sh
  - scripts/check-attestation-sign.sh
---

## Scope (RFC-0042 enabler, parallel to Phase 1)

Per RFC-0042 §Bypass-all-gates env var, add a single `AI_SDLC_BYPASS_ALL_GATES=1` env var honored by all four pre-push hooks. Single env var stops being needed if a future RFC removes the gates entirely; until then it's the operator's emergency-recovery escape.

This task **enables** shipping the rest of AISDLC-383 (especially Phase 1 — transcript capture — which would otherwise fight the AISDLC-380 sub-attestation gate). Parallel-track, no dependencies, ship first.

### Deliverables

1. Each of the 4 pre-push hooks checks `AI_SDLC_BYPASS_ALL_GATES=1` first and exits 0 silently if set:
   - `scripts/check-coverage.sh`
   - `scripts/check-task-moved.sh`
   - `scripts/check-dor-gate.sh`
   - `scripts/check-attestation-sign.sh`
2. Hermetic test per hook covering: env var set → exit 0 immediately; env var unset → normal behavior
3. CLAUDE.md hooks section updated to document the master escape
4. Runbook entry at `docs/operations/emergency-bypass.md` explaining when to use it + risks

### Acceptance criteria

- [ ] #1 `AI_SDLC_BYPASS_ALL_GATES=1 git push` succeeds end-to-end on a PR that would otherwise be blocked by all 4 gates
- [ ] #2 Existing `AI_SDLC_SKIP_*` env vars continue to work independently (no regression)
- [ ] #3 Hermetic tests for each hook cover both env-var-set and env-var-unset paths
- [ ] #4 CLAUDE.md updated; runbook documents the emergency-only nature
- [ ] #5 New code reaches 80%+ patch coverage (mostly env-var check additions)

## Out of scope

- Removing the existing per-gate `AI_SDLC_SKIP_*` env vars (those stay for targeted bypass)
- Adding gates to the bypass list (only the 4 existing pre-push hooks)
- CI-side bypass equivalent (CI checks remain; bypass is pre-push only)

## Source

RFC-0042 §Bypass-all-gates env var. Operator session 2026-05-20: "this friction is killing this project." Bypass var ships first so the rest of RFC-0042 implementation can be developed without fighting the very gates being rewritten.
