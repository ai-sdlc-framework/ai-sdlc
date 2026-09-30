---
id: AISDLC-658
title: >-
  RFC-0050 operator task: backfill before transcripts are pruned, first reports and snapshots, initial routing table
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - model-routing
  - operator
dependencies:
  - AISDLC-649
  - AISDLC-651
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - docs/operations/billing-and-cost-optimization.md
priority: high
dispatchable: false
dispatchableReason: "Operator-only: needs the operator machine, the provider usage screen and decisions about which cells to explore"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-run. The harness prunes old transcripts, so usage history that is not ingested
in time is lost. On 2026-09-30 only three main-session transcripts remained on the
operator's machine (oldest 2026-09-19) while subagent transcripts reached back to June.

## Scope
1. **Before anything else, stop the loss.** Raise the harness's transcript retention
   period in its settings, or copy the projects directory to a location outside its
   reach. This step does not need any task in this series to have shipped.
2. Once AISDLC-649 has shipped, run `cli-usage ingest --backfill` and record the
   counts it reports.
3. Run `cli-usage report` grouped by model and by role for the whole ingested range and
   compare the totals with the figures in the RFC-0050 Motivation tables. Note any
   difference and its cause.
4. Take a session-window and a weekly-window snapshot from the provider's usage screen
   on at least three separate days, then read `cli-usage allotment`.
5. Run `cli-usage context` and list the five sessions with the largest first-call
   context and the five with the most turns.
6. Commit this repository's `.ai-sdlc/model-routing.yaml` reproducing the current pins,
   then add candidates to the cells chosen for exploration and set `exploreShare`.
7. Write a short results note: usage per model and per role, the share taken by the
   main session, the implied allotment, and the cells opened for exploration with the
   reason for each.

## Acceptance Criteria
- [ ] Transcript retention is extended or the projects directory is copied, and the date this was done is recorded.
- [ ] A backfill has run and its scanned, written and skipped counts are recorded.
- [ ] Per-model and per-role totals are recorded and reconciled against the RFC-0050 Motivation tables.
- [ ] At least three snapshots per window exist and the implied-allotment series is recorded.
- [ ] `.ai-sdlc/model-routing.yaml` is on `main`, first reproducing current pins, then with the chosen candidates.
- [ ] A results note records the figures listed in step 7.
<!-- SECTION:DESCRIPTION:END -->
