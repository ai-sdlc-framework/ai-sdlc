---
id: AISDLC-278
title: 'feat: RFC-0024 Refit Phase 6 — §15.1 Lifecycle defaults + OQ-6 rate ceiling + OQ-9 stale ladder'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-6
  - critical-path-rfc-0035
dependencies:
  - AISDLC-320
  - AISDLC-321
  - AISDLC-275
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 6. Closes the §15.1 + OQ-6 + OQ-9 gaps. Implements the timebox + default-on-silence substrate that makes the entire capture lifecycle non-blocking under operator fatigue.

## Scope (§15.1 lifecycle timeboxes)

- `.ai-sdlc/capture-config.yaml` schema with the 4 timeboxes:
  - `draftAutoSubmitDays` (OQ-1, default 7)
  - `pendingTriageDays` (OQ-2, default 14)
  - `unknownSeverityDays` (OQ-5, default 14)
  - `staleNotificationLadder` (OQ-9: tuiHighlightDays 3 / slackDmDays 7 / emailDigestDays 14 / autoArchiveDays 21)
- Per-org configurability mandatory; sensible defaults shipped via `ai-sdlc init` template.
- Background timer service (cron-style or orchestrator-tick-driven) fires expiry actions.
- Reversibility per §15.1: every auto-action is reversible via the matching CLI.

## Scope (OQ-6 rate ceiling)

- Default ceiling 50 submitted captures/day/agent role.
- Threshold notification via Slack DM + TUI; full volume continues to corpus (no drops).
- Configurable per role in `capture-config.yaml`.
- `cli-capture-corpus volume <role>` reports current daily rate.

## Scope (OQ-9 stale ladder)

- Day 3: TUI blocker highlight (existing Rule 3 substrate amplifies the visual treatment).
- Day 7: Slack DM to capture owner.
- Day 14: email digest (weekly Sunday rollup).
- Day 21: classify via Phase 2 classifier + archive to `backlog/captures/archived/<id>.md`.
- Each threshold configurable per `capture-config.yaml`.
- Auto-resolve at 21d preserves audit (archived, not deleted) + signal (classifier guess attached for searchability) while removing from operator's active queue.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.ai-sdlc/capture-config.yaml` schema ships with 4 timeboxes + rate ceiling
- [ ] #2 `ai-sdlc init` capture-config template ships with defaults
- [ ] #3 Background timer service fires expiry actions (orchestrator-tick or cron)
- [ ] #4 OQ-1 draft auto-submit at 7d (configurable)
- [ ] #5 OQ-2 pending-triage auto-classify at 14d via Phase 2 classifier (configurable)
- [ ] #6 OQ-5 unknown-severity auto-classify at 14d via Phase 2 classifier (configurable)
- [ ] #7 OQ-6 rate-ceiling Slack DM + TUI notification at 50/day/agent (configurable)
- [ ] #8 OQ-9 stale ladder: 3d TUI → 7d Slack → 14d email → 21d archive
- [ ] #9 Archived captures preserved in `backlog/captures/archived/`; classifier guess attached
- [ ] #10 All auto-actions reversible per §15.1 contract
- [ ] #11 Integration test: capture progresses through full lifecycle ladder
- [ ] #12 RFC-0024 lifecycle flipped back to `Implemented` once all Refit Phases ship
<!-- AC:END -->
