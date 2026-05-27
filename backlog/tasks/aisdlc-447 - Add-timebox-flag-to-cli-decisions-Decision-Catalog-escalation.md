---
id: AISDLC-447
title: Add --timebox flag to cli-decisions (Decision Catalog escalation)
status: To Do
assignee: []
created_date: '2026-05-27 22:08'
labels:
  - decision-catalog
  - rfc-0035
  - vision-alignment
  - operator-friction
dependencies: []
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - VISION.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Decision Catalog's signature missing piece per VISION.md: decisions need a timebox so urgency escalates predictably. Today `cli-decisions add` has --reversible but no --timebox. The 18h passive heartbeat on 2026-05-26/27 happened because operator decisions had no urgency-escalation mechanism — task #262 (RFC-0024 lifecycle sign-off) sat unanswered overnight when a 4h timebox would have raised it as a morning blocker.



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: `cli-decisions add` accepts `--timebox <iso8601-duration>` (e.g. PT4H, P1D, P7D)
- [ ] AC-2: OR `--timebox <category>` accepting URGENT/24H/WEEK/BACKLOG with predefined durations
- [ ] AC-3: `cli-decisions list` sorts pending decisions by timebox-remaining ascending (most-urgent first)
- [ ] AC-4: `cli-decisions list --expired` filters to past-timebox decisions for operator triage
- [ ] AC-5: TUI surface (RFC-0023) shows timebox countdown on each pending decision
- [ ] AC-6: Operator-set override: `cli-decisions extend <id> --timebox <new>` with audit-log entry
- [ ] AC-7: Decision-opened events carry timebox metadata; downstream consumers (Slack, TUI) can subscribe

<!-- AC:END -->

## References

- spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
- VISION.md §1 (Decision Engine)
- pipeline-cli/src/decisions/feature-flag.ts (Phase 5 promotion already done)
- pipeline-cli/src/cli/decisions.ts (current add command)

