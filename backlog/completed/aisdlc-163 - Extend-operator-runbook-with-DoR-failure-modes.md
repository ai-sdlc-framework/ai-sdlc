---
id: AISDLC-163
title: 'Extend operator runbook with DoR-specific failure modes (refusal, bypass, escalation)'
status: Done
assignee: []
created_date: '2026-05-02'
labels:
  - docs
  - dor
  - runbook
  - rfc-0011
milestone: m-3
dependencies:
  - AISDLC-115.7
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - docs/operations/operator-runbook.md
  - docs/operations/dor-promotion.md
  - backlog/tasks/aisdlc-115 - RFC-0011-Definition-of-Ready-Gate-for-Pipeline-Admission.md
parent_task_id: AISDLC-115
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes AISDLC-115 (parent) AC #6: "operator runbook extended with
DoR-specific failure modes (refusal flow, bypass mechanism, escalation
paths)."

Until this task, the operator runbook covered the original RFC-0010
failure modes (`WorktreeOwnershipMismatch`, `RebaseConflict`, stuck
heartbeats, `IndependenceViolated`, `MigrationDiverged`,
`BranchQuotaExceeded`) but had no operational coverage for the DoR gate
shipped in AISDLC-115.1 through 115.7. The promotion runbook
(`dor-promotion.md`) covers the warn-only → enforce flip but not the
day-to-day failure modes once the gate is enforcing.

This task adds a "Definition-of-Ready (DoR) Gate" section to
`docs/operations/operator-runbook.md` with three subsections matching
the failure modes specified in RFC-0011 §6.3 + §7.4:

1. **Refusal flow** — what the operator sees when a Stage A or Stage B
   gate fails, where to look for diagnostics, what the agent recovers
   automatically, and when the operator intervenes.
2. **Bypass mechanism** — when + how to apply the `dor-bypass` label
   (RFC-0011 §7.4), what it overrides (the seven gates + status block),
   what it does NOT override (security gates, schema validation, the
   trusted-reviewer role check itself, the audit trail).
3. **Escalation paths** — the 3-round escalation pattern (RFC-0011
   §6.3) plus the low-confidence auto-escalation (RFC-0011 Q4); what
   triggers each round, what the operator does at round 3 (4-option
   matrix: approve / close / split / coach).

Cross-references both `dor-promotion.md` (for the promotion procedure)
and RFC-0011 (for the normative spec). Also adds the cross-references
to the runbook's "Related Documents" section for discoverability.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New "Definition-of-Ready (DoR) Gate" H2 section added to `docs/operations/operator-runbook.md` with H3 subsections for refusal flow, bypass mechanism, and escalation paths
- [x] #2 Each subsection includes symptoms (what operator sees), diagnosis (where to look), and resolution (what to do)
- [x] #3 Cross-references to RFC-0011 §6.3, §7.3, §7.4, §10 included in the new section
- [x] #4 Cross-reference to `docs/operations/dor-promotion.md` for the promotion procedure
- [x] #5 No new files created — `operator-runbook.md` edited in place; new entries added to "Related Documents" section for discoverability
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read existing `operator-runbook.md` to confirm structure + tone (H2 top-level sections, H3 subsections, "symptom / cause / recovery" pattern in existing recovery runbooks).
2. Read `dor-promotion.md` to confirm scope boundary — promotion runbook handles the warn-only → enforce flip; this runbook handles steady-state failure modes.
3. Read AISDLC-115.4 (Phase 3 orchestration), 115.5 (PPA composition + execute refusal), 115.7 (bypass + escalation) for canonical behavior.
4. Read RFC-0011 §6.2, §6.3, §7.1, §7.2, §7.3, §7.4, §10 for normative spec.
5. Insert the new section after "Recovery Runbooks" (after `BranchQuotaExceeded`) and before "Chaos test plan" — natural placement between operational concerns.
6. Add cross-refs to "Related Documents" (RFC-0011 + `dor-promotion.md`).
7. Conventional commit; docs-only push with `AI_SDLC_SKIP_COVERAGE_GATE=1`; open PR.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:SUMMARY:BEGIN -->
## Summary

Added a new "Definition-of-Ready (DoR) Gate" H2 section to
`docs/operations/operator-runbook.md` covering the three failure modes
the operator owns once the gate is enforcing: refusal flow (Stage A/B
gate failure), bypass mechanism (`dor-bypass` label), and escalation
paths (3-round + low-confidence). Each subsection follows the runbook's
existing symptoms / diagnosis / resolution pattern. Cross-references
RFC-0011 §6.3 + §7.3 + §7.4 + §10 (normative spec) and
`docs/operations/dor-promotion.md` (warn-only → enforce promotion).
Closes AISDLC-115 parent AC #6.

## Changes

- `docs/operations/operator-runbook.md` (modified): added "Definition-of-Ready (DoR) Gate" H2 section between "Recovery Runbooks" and "Chaos test plan"; added RFC-0011 + `dor-promotion.md` entries to "Related Documents".
- `backlog/tasks/aisdlc-163 - ...md` (new, then moved to completed): task file for traceability per the backlog workflow.

## Design decisions

- **Standalone H2, not an H3 under "Recovery Runbooks"** — DoR has three distinct failure modes (refusal, bypass, escalation) that compose in non-linear ways (escalation routes to bypass; bypass is the round-3 outcome). Treating it as a single recovery runbook would have flattened that structure. The H2 also surfaces it in the runbook's TOC at the same level as the other operational concerns.
- **Symptoms / diagnosis / resolution triad** — matches the existing recovery-runbook pattern (see `WorktreeOwnershipMismatch`, `RebaseConflict`). Keeps the operator's mental model consistent.
- **Cross-referenced rather than duplicated** — `dor-promotion.md` already covers the warn-only → enforce flip; the new section explicitly defers to it for that procedure and only documents enforcement-mode failure modes. Avoids drift.
- **4-option escalation matrix** — RFC-0011 §6.3 names four soft-handoff outcomes (approve / close / split / coach). Surfacing them as a table makes the operator's decision tree explicit and matches the runbook's existing tabular style.

## Verification

- Docs-only change; no code path touched.
- Manual review: section structure matches surrounding runbook tone + format.
- Cross-references resolve (`./dor-promotion.md`, `../../spec/rfcs/RFC-0011-definition-of-ready-gate.md`).
- `git diff` confirms only `operator-runbook.md` changed; no new files outside `backlog/tasks/`.

## Follow-up

- (none) — closes AISDLC-115 parent AC #6.
<!-- SECTION:SUMMARY:END -->
