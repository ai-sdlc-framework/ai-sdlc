---
id: AISDLC-336
title: 'docs: RFC-0036 Phase 11 — adopter-authoring promotion runbook (hybrid promotion to default-on)'
status: Done
assignee: []
created_date: '2026-05-16'
updated_date: '2026-05-27'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-11
  - docs
dependencies:
  - AISDLC-330
  - AISDLC-331
  - AISDLC-332
  - AISDLC-333
  - AISDLC-334
  - AISDLC-335
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - docs/operations/dor-promotion.md
  - docs/operations/orchestrator-promotion.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 11 of RFC-0036 §13. Hybrid promotion runbook to flip `AI_SDLC_ADOPTER_AUTHORING=experimental` flag to default-on. Operator dispatches the flip once corpus or spot-check evidence supports it.

## Scope

- `docs/operations/adopter-authoring-promotion.md` runbook.
- Covers: adopter-corpus accuracy threshold (≥N adopters using import-spec successfully); spot-check protocol; rollback procedure; monitoring after flip.
- Cross-references RFC-0011 + RFC-0014 + RFC-0015 promotion runbooks.
- Promotion ladder: `experimental` → shadow-mode → default-on documented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `docs/operations/adopter-authoring-promotion.md` ships
- [x] #2 Covers: adopter-corpus threshold, spot-check protocol, rollback, post-flip monitoring
- [x] #3 Cross-references RFC-0011/0014/0015 promotion runbooks
- [x] #4 Promotion ladder documented: experimental → shadow → default-on
- [x] #5 Adopter-facing example walkthrough included
<!-- AC:END -->

## finalSummary

### Summary
Shipped `docs/operations/adopter-authoring-promotion.md` — the hybrid
corpus-OR-override promotion runbook for flipping `AI_SDLC_ADOPTER_AUTHORING`
from `experimental` to default-on, closing RFC-0036 Phase 11. Mirrors the
established RFC-0011 / RFC-0014 / RFC-0015 promotion-runbook pattern.

### Changes
- `docs/operations/adopter-authoring-promotion.md` (new): hybrid promotion
  runbook covering the corpus path (≥10 attempts / ≥3 orgs / ≥95% accuracy
  / 0 open catalog escalations / ≥5 RFC scaffold invocations), the override
  path (fixture spot-checks + catalog scan + scaffold verification), the
  three-state promotion ladder (experimental → shadow-mode → default-on),
  an adopter-facing before/after walkthrough, the parser-introducing
  flag-flip mechanics (Option A single-PR vs Option B shadow), post-flip
  monitoring metrics, and rollback procedure.

### Design decisions
- **No dedicated corpus aggregator binary**: unlike RFC-0014's
  `cli-deps-corpus` and RFC-0015's `cli-orchestrator-corpus`, RFC-0036
  doesn't ship a per-tick observable surface — the adopter signal is
  conversational (import attempts, catalog escalations, scaffold
  invocations). The runbook documents manual corpus assembly via `jq`
  over `imports.jsonl` + `cli-decisions list` queries.
- **Three-state promotion ladder** (experimental → shadow → default-on):
  shadow-mode is OPTIONAL but recommended for the first cutover to
  surface deployment-config drift before the full cascade.
- **Parser introduction is part of the flip**: phases 1-10 implemented
  the surfaces (`cli-import-spec`, `cli-rfc init`, config reader,
  DoR-at-import) under the opt-in assumption — there's no pre-flip
  parser. The runbook documents the parser-introducing PR shape
  mirroring the RFC-0015 pattern.

### Verification
- Docs-only PR — no build/test/lint run required (paths-ignore skips
  attestation + review workflows per AISDLC-388).

### Follow-up
- The actual flag-flip PR is a separate task (to be filed once corpus
  evidence accumulates per the runbook). This task ships only the
  runbook.
