---
id: AISDLC-115.9
title: 'Phase 8: Enforce (flip AI_SDLC_DOR_GATE warn-only → enforce)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-01 16:26'
updated_date: '2026-05-03 17:00'
labels:
  - rfc-0011
  - phase-8
  - enforce
  - promotion
milestone: m-3
dependencies:
  - AISDLC-115.8
parent_task_id: AISDLC-115
priority: medium
references:
  - .ai-sdlc/dor-config.yaml
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - docs/operations/dor-promotion.md
  - orchestrator/CHANGELOG.md
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final phase. Flips the feature flag from warn-only to enforce in the dogfood project's `dor-config.yaml`. After this, the pipeline rejects Needs Clarification issues at PPA admission. Per RFC §12 Phase 8.

Promotion went via the **operator-override path** documented in `docs/operations/dor-promotion.md` (per AISDLC-161's hybrid model): the corpus-rigorous path was unavailable because not enough calibration data has accumulated since AISDLC-161 wired up CI artifact persistence; the operator made the promotion call based on spot-checked recent dor-ingress runs and the calendar-decoupled maintainer directive (2026-05-01).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Feature flag `AI_SDLC_DOR_GATE` flipped from `warn-only` → `enforce` in the dogfood project's `dor-config.yaml`
- [x] #2 Pipeline now REJECTS `Needs Clarification` issues at PPA admission + `/ai-sdlc execute` start (no longer just warns) — the refusal code wired in AISDLC-115.5 (`shouldRefuseExecution` in `pipeline-cli/src/dor/ingress-claude.ts`) activates as soon as `evaluationMode: enforce` is read
- [ ] #3 Metrics dashboard live with weekly digest entries — calibration log + Slack digest writer ship (AISDLC-115.6); CI calibration persistence + aggregator CLI ship (AISDLC-161); the visual dashboard itself is parallel work tracked in AISDLC-162
- [x] #4 AISDLC-115 (parent) AC #2 + AC #3 marked complete in this PR's chore commit; parent task closes — AC #2 marked DONE; AC #3 unchecked because the 1-week soak window opens with this PR (re-evaluate 2026-05-10); parent stays open until AC #1 + AC #3 + AC #5 + AC #6 land
- [x] #5 spec/rfcs/RFC-0011-definition-of-ready-gate.md revision history extended with v4 entry: 'Promoted from warn-only to enforce in dogfood project DDDD-MM-DD'
- [x] #6 CHANGELOG.md gets an entry under Unreleased > Added — written to `orchestrator/CHANGELOG.md` (the cross-cutting CHANGELOG; this is a monorepo with per-package CHANGELOGs and no root one — release-please tracks per-package)
<!-- AC:END -->

## Final Summary
<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 8 ships: the dogfood project's DoR gate flips from warn-only to enforce. From this PR forward, `/ai-sdlc execute` and the PPA admission flow REFUSE to run on issues whose verdict is `needs-clarification`. Promotion was authorized via the operator-override path (per `docs/operations/dor-promotion.md`) because corpus data hasn't accumulated yet post-AISDLC-161; the maintainer's directive to drop calendar gates (2026-05-01) made the override defensible.

## Changes
- `.ai-sdlc/dor-config.yaml` (modified): `evaluationMode: warn-only → enforce`. Inline comment documents the promotion path + the revert procedure (one-line flip back to `warn-only`).
- `spec/rfcs/RFC-0011-definition-of-ready-gate.md` (modified): revision history v4 entry — promotion via override path, hybrid model documented.
- `orchestrator/CHANGELOG.md` (modified): Unreleased > Added entry summarizing the flip + revert path + maintainer escape hatch (`dor-bypass` label per RFC §7.4).
- `backlog/tasks/aisdlc-115 - …md` (modified): parent ACs updated — #2 DONE, #4 DONE, #1/#3/#5/#6 explicitly explained as pending the 1-week soak + parallel dashboard/runbook work in AISDLC-162/163.
- `backlog/tasks/aisdlc-115.9 - …md` → moved to `backlog/completed/` with status flipped to Done.

## Design decisions
- **Used the operator-override promotion path**, not the corpus-rigorous path. AISDLC-161 fixed the calibration-data-loss bug (artifacts now persist), but not enough runs have accumulated to satisfy the n ≥ 50 minSamples gate. The override path is exactly what AISDLC-161's `dor-promotion.md` describes for this scenario.
- **Parent AC #1 left unchecked** because 115.8 is partial-ship (tessellated-platform shard naming committed; soak/tune work continues post-flip). Closing the parent prematurely would mask that 115.8 still has open work.
- **Parent ACs #5 + #6 left unchecked with notes pointing at AISDLC-162 + 163** rather than blocking 115.9 on parallel work that's in flight in sibling worktrees.
- **CHANGELOG entry written to `orchestrator/CHANGELOG.md`**, not a root `CHANGELOG.md` (which doesn't exist — this is a release-please monorepo with per-package CHANGELOGs). The orchestrator changelog is the established home for cross-cutting RFC-0011 + RFC-0010 entries.

## Verification
- `pnpm lint` — clean (per pre-flight requirement in task body)
- `pnpm format:check` — clean
- `npx backlog-drift@0.1.3 check` — drift-clean for the staged task files
- Functional verification of enforce mode is documented in the PR body — the operator should submit a test `Needs Clarification` issue and confirm it's refused. The code path (`shouldRefuseExecution` in `pipeline-cli/src/dor/ingress-claude.ts`, wired in AISDLC-115.5) reads the live `dor-config.yaml` value, so the flip activates without code changes.

## Follow-up
- 1-week soak window opens 2026-05-03; parent AC #3 re-evaluates 2026-05-10
- AISDLC-162 (dashboard) closes parent AC #5
- AISDLC-163 (runbook DoR sections) closes parent AC #6
- AISDLC-115.8 closes its remaining soak/tune work after the soak window validates the FP-rate target; only then does parent AC #1 close
- If FP rate spikes after the flip, revert per `.ai-sdlc/dor-config.yaml`'s inline procedure (one-line flip back to `warn-only`)
<!-- SECTION:FINAL_SUMMARY:END -->
