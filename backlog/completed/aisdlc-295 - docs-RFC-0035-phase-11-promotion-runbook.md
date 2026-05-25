---
id: AISDLC-295
title: 'docs: RFC-0035 Phase 11 — Hybrid promotion runbook'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-15'
updated_date: '2026-05-24'
labels:
  - rfc-0035
  - decision-catalog
  - phase-11
  - docs
dependencies:
  - AISDLC-293
blocked:
  reason: 'RFC-0035 OQ status acknowledged — RFC is Ready for Review with all 14 OQs resolved (operator walkthrough 2026-05-15); Phase 11 docs ship while the RFC awaits per-owner sign-off per the documented critical path. RFC-0011 OQ-10 is a cost-estimation question, non-blocking for a Phase 11 docs PR that only references RFC-0011.'
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - docs/operations/dor-promotion.md
  - docs/operations/orchestrator-promotion.md
  - docs/operations/decision-catalog-promotion.md
  - docs/operations/deps-composition-promotion.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 11 of RFC-0035 Implementation Plan (§14). Operator dispatches the default-on flip from a runbook once corpus or spot-check evidence supports it, mirroring the project's promotion convention (RFC-0011 DoR, RFC-0015 orchestrator).

## Scope

- `docs/operations/decision-catalog-promotion.md` runbook
- Covers: corpus accuracy threshold, spot-check protocol, rollback procedure, monitoring after flip
- Cross-references RFC-0014 + RFC-0015 promotion runbooks
- Documents the promotion ladder: experimental → shadow-mode → default-on
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `docs/operations/decision-catalog-promotion.md` ships
- [x] #2 Runbook covers corpus accuracy threshold, spot-check protocol, rollback procedure, monitoring after flip
- [x] #3 Cross-references RFC-0014 + RFC-0015 promotion runbooks
- [x] #4 Promotion ladder documented: experimental → shadow-mode → default-on
- [x] #5 Adopter-facing example walkthrough included
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
### Summary

Ships `docs/operations/decision-catalog-promotion.md` — the RFC-0035 Phase 11
hybrid promotion runbook for flipping `AI_SDLC_DECISION_CATALOG` from
default-OFF to default-ON. Modeled on the RFC-0014 (`deps-composition-promotion.md`)
and RFC-0015 (`orchestrator-promotion.md`) sister runbooks; same
corpus-or-override two-path structure operators already know.

### Changes

- `docs/operations/decision-catalog-promotion.md` (new): full runbook with
  corpus path (`cli-decisions corpus aggregate`), override path
  (`cli-decisions exemplars {list,digest,sweep,affirm,reclassify,reject,promote-all}`),
  the flag flip itself (Option A parser-default flip + Option B env-block
  override), explicit promotion ladder (experimental → shadow-mode →
  default-on), post-flip monitoring cadence, rollback procedure with
  rollback-trigger metrics, and an adopter-facing 30-day walkthrough.
  Cross-references the three sister runbooks (deps-composition,
  orchestrator, dor-promotion).

### Design decisions

- **"Shadow-mode" framed as configuration convention, not a separate
  code branch.** The parser is binary (on/off); "shadow-mode" is the
  operator's name for the phase where the flag is on AND DoR ingress
  emits Decisions AND the TUI surface is still opt-in. Documenting it
  as a convention rather than inventing a third parser state preserves
  the existing two-state implementation and avoids the failure mode
  where new operators look for a `shadow` enum value that doesn't
  exist.
- **Retrospective framing.** The dogfood project already promoted via
  AISDLC-392 (default-on since 2026-05-22). The runbook calls this out
  in the opening note + explains the two retained audiences: adopter
  projects flipping their own deployment, and the dogfood operator if
  rollback evidence ever surfaces. Avoids the trap of writing a "do
  this now" runbook for a flip that's already done.
- **80% accuracy floor for `decision-recommendation`** (lower than
  RFC-0011 DoR's 90%) because Decision Catalog recommendations are
  *advisory* — every recommendation goes through the OQ-3 override
  window, so wrong recommendations are catch-able rather than
  silently load-bearing. Documented inline so adopters don't
  mis-apply RFC-0011's stricter threshold.
- **Monitoring cadence: weekly digest / bi-weekly aggregate /
  quarterly sweep.** Targets ~10 minutes/week of operator attention
  in steady state. Documents explicit rollback triggers (accuracy
  drift, override-rate spike, anchor pile-up) so the runbook is
  bidirectional.

### Verification

- `pnpm exec prettier --check docs/operations/decision-catalog-promotion.md` — clean
- `pnpm exec prettier --check docs/operations/` — clean
- `node pipeline-cli/bin/cli-dor-check.mjs --task <task-file>` — exit 0
- Docs-only PR: `pnpm build && pnpm test && pnpm lint` skipped per
  task scope (no source code modified, only one new markdown file
  added).

### Follow-up

- (none) — the runbook is the Phase 11 deliverable per RFC-0035 §14.
  Downstream phases (governance reporting integration) are tracked
  separately under their own RFCs.
<!-- SECTION:FINAL_SUMMARY:END -->
