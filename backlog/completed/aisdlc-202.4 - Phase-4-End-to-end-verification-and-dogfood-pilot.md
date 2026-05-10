---
id: AISDLC-202.4
title: 'Phase 4: End-to-end verification and dogfood pilot'
status: Done
assignee: []
created_date: '2026-05-05 20:15'
labels:
  - rfc-0012
  - codex
  - phase-4
  - verification
  - dogfood
parentTaskId: AISDLC-202
dependencies:
  - AISDLC-202.3
references:
  - pipeline-cli/src/cli/execute.ts
  - docs/operations/operator-runbook.md
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

After AISDLC-202.1 (design map), 202.2 (adapter), and 202.3 (attestation + finalization), the Codex execution path needs end-to-end verification on a real backlog task before being declared production-ready.

## Goal

Run a safe test task through the Codex CLI workflow end-to-end, observe the full Step 0-13 lifecycle, and capture verification notes for the operator runbook. The pilot serves as the proof that the path is reusable, not a one-off like AISDLC-201.

## Implementation notes

Pick a small, contained backlog task as the pilot — ideally something with limited blast radius (a docs change or a localized bug fix). Don't pilot on critical-path work.

Capture metrics that operators care about:
- Wall-clock from dispatch to PR open
- Reviewer subagent counts + token usage (for the cost-cap calibration story)
- Any manual-intervention points encountered (these are bugs to file)
- DSSE attestation verification result (with the harness field from 202.3)

Write up the result as a short section in the operator runbook — "Codex pilot results" — that reads like a postmortem.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A safe test task is run through the Codex CLI workflow end to end with PR creation and DSSE attestation, with no manual intervention required between dispatch and PR open.
- [ ] #2 Verification notes captured in the task's final summary: wall-clock, reviewer counts, token usage, any anomalies, DSSE verification result.
- [ ] #3 Operator runbook (`docs/operations/operator-runbook.md`) gains a "Codex pilot results" section summarizing the run + recommendations for when to use Codex.
- [ ] #4 If any manual-intervention points were encountered, follow-up backlog tasks are filed for each.
- [ ] #5 RFC-0012 revision history updated with a note that Codex CLI is now a supported harness option (or, if the pilot revealed blockers, an explicit "Codex blocked on X" entry).
<!-- AC:END -->
