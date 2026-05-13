---
id: AISDLC-269
title: 'chore: complete RFC-0024 capture authoring + triage flow'
status: To Do
assignee: []
created_date: '2026-05-13 18:48'
labels:
  - rfc-0024
  - retrofit-followup
  - emergent-capture
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - pipeline-cli/src/tui/blockers/detector.ts
  - pipeline-cli/src/tui/corpus/aggregate.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete the unbuilt portion of RFC-0024 (Emergent Issue Capture + Triage Pattern). The detection substrate ships today; the capture authoring and triage decision flow do not.

## What ships today (per 2026-05-13 audit)

- pipeline-cli/src/tui/blockers/detector.ts — Rule 3 detects pending-triage capture records and surfaces them as TUI blockers (cites RFC-0024 directly)
- pipeline-cli/src/tui/corpus/aggregate.ts — TuiCaptureFiled event aggregation tied to RFC-0024 capture IDs

## What's missing

The authoring half of the loop — operators and AI agents currently have nowhere to record a capture, so the detector has no input. The triage decision flow that consumes capture records and produces backlog Issues or scope decisions also does not exist.

## Why this matters

RFC-0024 sits on the critical path for RFC-0035 (Decision Catalog): RFC-0035 source emergent-finding decision feeder reads capture records as input. RFC-0035 design contract cannot stabilize until RFC-0024 capture and triage flow is shipped.

## Pre-work required

The 12 Open Questions in RFC-0024 §15 still need an operator walkthrough before this implementation can land. Each OQ has an author Recommendation in the RFC body; the walkthrough resolves recommendations into normative answers and unblocks Phase 1 of this task.

## References

- RFC-0024 §5 (Capture sources), §6 (Capture record schema), §7 (Triage rubric), §9.2 (Decision-pending → decision-deferred handoff)
- pipeline-cli/src/tui/blockers/detector.ts (existing detector Rule 3)
- pipeline-cli/src/tui/corpus/aggregate.ts (existing event aggregator)
- Surfaced by the 2026-05-13 partial-implementation status retrofit pass
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `cli-capture` CLI ships per RFC-0024 §5.1 (subcommands: file, list, redact, against-current-pr) with the capture record schema from §6
- [ ] #2 PR-comment marker parser ships per §5.2 (parses `ai-sdlc:capture` markers in PR review comments and creates capture records)
- [ ] #3 In-code marker linter ships per §5.3 (`// ai-sdlc:capture` prefix detection; non-blocking warning)
- [ ] #4 AI-agent direct-capture path ships per §5.4 (subagents can emit captures via prompted output protocol)
- [ ] #5 Triage rubric implementation per §7 — operator promotes a capture to backlog Issue, scope-creep merge, or new RFC; default pending until decision
- [ ] #6 DoR integration per §8 — DoR clarification rounds can spawn captures; capture corpus is one input to PPA scoring
- [ ] #7 RFC-0011 + RFC-0015 integration tests confirm capture flow does not block dispatch (decision-deferred handoff per §9.2)
- [ ] #8 RFC-0024 §15 OQs resolved with normative answers (operator walkthrough required first); §15 retrofit follows the 2026-05-13 partial-impl pattern
- [ ] #9 RFC-0024 lifecycle flipped to Implemented; registry row + inventory entry updated
<!-- AC:END -->
