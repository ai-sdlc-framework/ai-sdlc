---
id: AISDLC-447
title: Add --timebox flag to cli-decisions (Decision Catalog escalation)
status: Done
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

- [x] AC-1: `cli-decisions add` accepts `--timebox <iso8601-duration>` (e.g. PT4H, P1D, P7D)
- [x] AC-2: OR `--timebox <category>` accepting URGENT/24H/WEEK/BACKLOG with predefined durations
- [x] AC-3: `cli-decisions list` sorts pending decisions by timebox-remaining ascending (most-urgent first)
- [x] AC-4: `cli-decisions list --expired` filters to past-timebox decisions for operator triage
- [ ] AC-5: TUI surface (RFC-0023) shows timebox countdown on each pending decision
- [x] AC-6: Operator-set override: `cli-decisions extend <id> --timebox <new>` with audit-log entry
- [x] AC-7: Decision-opened events carry timebox metadata; downstream consumers (Slack, TUI) can subscribe

<!-- AC:END -->

## References

- spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
- VISION.md §1 (Decision Engine)
- pipeline-cli/src/decisions/feature-flag.ts (Phase 5 promotion already done)
- pipeline-cli/src/cli/decisions.ts (current add command)

## Final Summary

### Summary

Shipped the `--timebox` flag end-to-end for `cli-decisions add` + `cli-decisions extend` + sort/filter on `cli-decisions list`. Decisions now carry a per-record timebox (ISO-8601 duration or categorical alias URGENT/24H/WEEK/BACKLOG) that drives urgency ordering and `--expired` triage. AC-5 (TUI countdown surface) is deferred to a follow-up — it requires wiring into the `decisions-pending` TUI pane (RFC-0023), which is a separate plumbing concern from the CLI/event-model substrate landed here.

### Changes

- `pipeline-cli/src/decisions/timebox.ts` (new): pure parser (`parseTimebox`, `parseIsoDurationToMs`, `computeTimeboxExpiresAt`, `msRemainingUntil`, `isTimeboxExpired`) + categorical-alias table.
- `pipeline-cli/src/decisions/decision-record.ts` (modified): added `spec.timebox` + `status.timeboxExpiresAt` to the `Decision` type; extended `DecisionOpenedEvent` with `timebox`/`timeboxExpiresAt`; added new `TimeboxExtendedEvent` type + validator branch; appended `timebox-extended` to `DECISION_EVENT_TYPES`.
- `pipeline-cli/src/decisions/event-log.ts` (modified): extended `makeDecisionOpenedEvent` to persist timebox fields; added `makeTimeboxExtendedEvent` factory.
- `pipeline-cli/src/decisions/projection.ts` (modified): folds `timebox`/`timeboxExpiresAt` from `decision-opened`; handles `timebox-extended` (updates `status.timeboxExpiresAt` + `spec.timebox`); exports `sortDecisionsByTimeboxUrgency`, `isDecisionTimeboxExpired`, `filterExpiredDecisions`.
- `pipeline-cli/src/decisions/index.ts` (modified): re-exports timebox module.
- `pipeline-cli/src/cli/decisions.ts` (modified): `add --timebox <input>` parses + persists; `list` defaults to timebox-urgency sort (with `--sort created` legacy escape), `--expired` filter, timebox column in table mode; new `extend <id> --timebox <new>` subcommand emits audit event.
- `spec/schemas/decision.v1.schema.json` (modified): added `spec.timebox`, `status.timeboxExpiresAt`, and `timebox-extended` to event-type enum.
- Tests (new + extended): `timebox.test.ts` (34 cases), `projection.test.ts` (+5 describes), `decisions.test.ts` (+19 cases) — covers parser, event folding, sort, filter, all 3 CLI flows + error paths.

### Design Decisions

- **Categorical aliases resolve at add-time** to canonical ISO-8601 form. The operator's intent (URGENT) lives on the CLI surface; the persisted event carries the resolved duration (PT4H) so downstream consumers don't have to know the alias table.
- **Expiry computed at write time + persisted on the event**. Avoids two readers on different clocks disagreeing about when the decision expires, and keeps `cli-decisions list --expired` purely event-replay.
- **`timebox-extended` is a separate event type from `timebox-fired`** (which was reserved but unused). Extension is operator-initiated; firing is system-initiated. Conflating them would muddy the audit trail.
- **Sort default flipped to timebox-urgency** (AC-3 mandate). For backward-compat, untimeboxed decisions sort last by creation-asc, and `--sort created` restores the prior behaviour.
- **Months/years use averaged durations** (30d / 365.25d) rather than calendar arithmetic — deterministic at projection time across timezones.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 5648/5648 pass
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Coverage: pipeline-cli 91.57% lines (above 80% gate); `timebox.ts` 97.64%; `projection.ts` 100%.

### Follow-up

- **AC-5 (TUI countdown)**: wire `formatTimeboxBadge` or equivalent into `pipeline-cli/src/tui/decisions-pending/` so each pending decision row shows live countdown. RFC-0023 dependency. File as a follow-up task if operator authorizes.
- **Slack consumer**: events.jsonl now carries timebox metadata; a separate "decision-opened with timebox" Slack notifier can subscribe (per AC-7's "downstream consumers" phrasing).

