---
id: AISDLC-115.8
title: 'Phase 7: Soak + tune + tessellated-platform shard naming'
status: Done
assignee: []
created_date: '2026-05-01 16:26'
updated_date: '2026-05-03 00:24'
labels:
  - rfc-0011
  - phase-7
  - soak
  - tune
  - shard-naming
milestone: m-3
dependencies:
  - AISDLC-115.7
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
parent_task_id: AISDLC-115
priority: medium
dispatchable: false
dispatchableReason: >-
  Soak phase — operator-driven exit criterion (FP rate < 10% per gate AND
  override-rate plateau in calibration.jsonl). No code work for a developer
  subagent; progress is driven by real usage accumulating corpus data.
blocked:
  reason: 'Soaking — code slice (ACs #3, #4, #6) shipped; ACs #1, #2, #5 are operator-driven soak data accumulating in $ARTIFACTS_DIR/_dor/calibration.jsonl. Phase 7 exit criterion is corpus-driven (FP rate < 10% per gate AND override-rate plateau), NOT calendar-driven.'
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#12-implementation-plan
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      backlog/docs/ppa-product-signoff-rfc0011.md
    resolution: flagged
  - date: '2026-05-03'
    type: dep-resolved
    detail: Dependency AISDLC-115.7 has been completed
    resolution: flagged
  - date: '2026-05-03'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
  - date: '2026-05-03'
    type: dep-resolved
    detail: Dependency AISDLC-115.7 has been completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Soak + tune phase. Folds in Alex's Addition 2 (tessellated-platform shard naming). Per maintainer directive 2026-05-01, the exit criterion is corpus-driven (false-positive rate threshold), NOT calendar-driven. Whichever comes first — calendar duration is a side-effect, not a gate. Per RFC §12 Phase 7.

## Partial-ship status (2026-05-02)

This task is split into a code-deliverable slice (ACs #3, #4, #6 — shipped) and an operator-driven soak slice (ACs #1, #2, #5 — operator follow-up). The code slice ships in PR `ai-sdlc/aisdlc-115.8-soak-shard`; the soak slice runs the system in `warn-only` against the real issue stream and tunes Stage B from observed false-positives.

### Abstraction state — no upstream "Tessellated DID" code exists yet

RFC-0008 §4.2 + Addendum B describe a Design Intent Document with `soulPurpose`, `experientialTargets`, `brandIdentity`, etc. — none of that is implemented in `pipeline-cli/` or `orchestrator/` today. Rather than block on building a full DID loader, this slice ships a **minimal `ProjectShardManifest` scaffold** (`{ shards: string[]; manifestRef?: string }`) on `IssueInput`. When a future DID loader lands, it can project into this shape without breaking Gate 5's API. Documented inline at `pipeline-cli/src/dor/types.ts` and `pipeline-cli/src/dor/gates/gate-5-surface.ts`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Run DoR in `warn-only` mode against real issue stream (no blocking); collect false-positive data to calibration log per Phase 5
- [ ] #2 Tune Stage B agent prompt + per-gate severity based on observed false-positives
- [x] #3 Tessellated-platform shard naming per Alex's Addition 2: when project's DID is a Tessellated DID with >1 shard, Gate 5 also requires shard identification; clarification message lists shard names
- [x] #4 Single-shard / non-tessellated platforms unaffected by the new check (regression test)
- [ ] #5 Phase 7 EXIT CRITERION (corpus-driven, NOT calendar-driven per maintainer directive 2026-05-01): false-positive rate < 10% per gate AND override-rate plateau in calibration log
- [x] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Operator follow-up (ACs #1, #2, #5)

These ACs are data-driven, NOT code-driven. They cannot be discharged by a developer agent because they depend on running the system + accumulating false-positive observations. After this PR merges:

1. **AC #1** — Operator runs the dogfood pipeline with `evaluationMode: warn-only` (already the default per `dor-config.ts`) against the real GitHub-issue + backlog-task stream and lets the calibration log accumulate (`$ARTIFACTS_DIR/_dor/calibration.jsonl`, AISDLC-115.6).
2. **AC #2** — Once calibration data exists, the operator inspects the FP buckets per gate and tunes either (a) the `refinement-reviewer.md` Stage B prompt or (b) per-gate `severity` overrides via `dor-config.yaml`. No new code changes anticipated for the framework itself.
3. **AC #5** — Operator reads the weekly digest (`cli-dor-digest`, AISDLC-115.6) and flips the gate when (per-gate FP rate < 10%) AND (override-rate plateau visible). The flip itself is AISDLC-115.9 (Phase 8: Enforce).
