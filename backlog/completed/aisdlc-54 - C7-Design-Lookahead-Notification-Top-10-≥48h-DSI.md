---
id: AISDLC-54
title: C7 Design Lookahead Notification (Top-10 ≥48h + DSI)
status: Done
assignee: []
created_date: '2026-04-24 17:24'
updated_date: '2026-04-24 18:56'
labels:
  - c7
  - lookahead
  - notifications
  - M4
milestone: m-1
dependencies:
  - AISDLC-49
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - orchestrator/src/notifications/
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement §11 of RFC-0008. New `orchestrator/src/design-lookahead.ts` running on scheduler.

For every admitted item: if item has been in top-10 of prioritized backlog for ≥48h AND has design system impact (frontend code area OR `catalogGaps` non-empty OR tensionFlag includes `PRODUCT_HIGH_DESIGN_LOW`), emit design-team notification.

Payload is the full `pillarBreakdown` (not simplified) plus catalog gaps and tension flags — per RFC §11 update in Amendment 6. The design team needs to see whether a work item is high-priority-but-blocked-by-design-readiness versus low-priority-and-not-design-ready.

Dedupe per item via state table `design_lookahead_notifications(issue_number, first_notified_at)` with 7-day expiry.

Per OQ-7 resolution: 48h stability threshold prevents notification churn from volatile priority environments.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Item in top-10 for 47h → no notification; at 48h → one notification; later top-10 passages → no duplicate
- [x] #2 Item leaving top-10 and returning triggers new notification only after state expiry (default 7 days)
- [x] #3 Payload includes pillarBreakdown exactly as emitted by AISDLC-49
- [x] #4 No notification when item has no design system impact
- [x] #5 Tests with synthetic time source
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
C7 Design Lookahead detector landed — final M4 task. Emits `DesignLookaheadNotification` for top-10 backlog items that have remained stable for ≥48h and have design-system impact, deduped via `design_lookahead_notifications` with 7-day expiry.

## Changes
- `orchestrator/src/design-lookahead.ts` (new): `detectDesignLookaheadNotifications(items, deps)` takes a pre-ordered top-N backlog and returns notifications to emit for this tick. Applies stability threshold (48h default), design-impact detection (`detectDesignImpactReasons` — OR of frontend-components, catalog-gaps, PRODUCT_HIGH_DESIGN_LOW tension), and dedupe via `StateStore.getDesignLookaheadNotification` / `upsertDesignLookaheadNotification`. Exports `DEFAULT_LOOKAHEAD_CONFIG`, `BacklogItem`, `DesignImpactReason`, `DesignLookaheadNotification`, `DesignLookaheadConfig`, `DesignLookaheadDetectorDeps`.
- `orchestrator/src/design-lookahead.test.ts` (new): 16 tests — impact reason detection table (including negative case for non-design tensions), 47h→no-fire vs 48h→fire (AC #1), within-7d dedupe (AC #1), post-7d re-fire (AC #2), payload shape preservation (AC #3), no-impact skip (AC #4), missing enteredTop10At skip (AC #5), topN config respects cutoff, persistence of pillarBreakdown JSON, default config constants.

## Design decisions
- **Caller owns `enteredTop10At` tracking**: the detector is a pure scheduler-tick function that reads state from the database but doesn't maintain per-item in-memory history. The scheduler passes `BacklogItem[]` with `enteredTop10At` already populated (derived from its own backlog-stability tracking). Keeps the detector testable and avoids coupling to the caller's scheduling cadence.
- **`enteredTop10At` absent ⇒ skip, not just "not stable yet"**: matches AC #5 — items that just entered the top-10 this tick shouldn't fire. The caller is expected to record entry and bring it forward on subsequent ticks.
- **Dedupe window via `lastNotifiedAt`, not `firstNotifiedAt`**: AC #1 and AC #2 together say "no duplicates within 7d of the most-recent notification". When an item leaves and returns, the dedupe persists: we don't reset state on exit. The 7d clock runs from the last actual emission.
- **Three OR-combined impact reasons** — any one triggers. Returned in `reasons` for downstream audit; reviewers see both "why did this fire" and "how strong was each signal" (via the attached `pillarBreakdown`).
- **Non-design tension flags (PRODUCT_HIGH_ENGINEERING_LOW, etc.) do NOT trigger design lookahead** — only `PRODUCT_HIGH_DESIGN_LOW` maps to design impact. Other tensions have their own downstream consumers.
- **Upsert writes full `pillarBreakdown` as JSON** onto the notifications table, not just the issue number. Reviewers looking at the notification history can reconstruct *why* we notified without replaying the backlog state.
- **`topN` is configurable** but defaults to 10 per RFC-0008 §11. Tests verify items outside top-N are ignored even if they'd otherwise qualify.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/design-lookahead.test.ts` — 16/16 pass
- `pnpm vitest run` (full orchestrator) — 2035/2035 pass (+16)
- `pnpm lint` — clean

## Follow-up
All of M4 (AISDLC-51–54) is now done. Next up: M5 — Addendum B deterministic-first SA scoring (AISDLC-55 Python sidecar, AISDLC-56–63 three-layer scorer). M5 is the heaviest remaining milestone — Python service + BM25 + LLM integration + `pattern-test` CLI + exemplar bank.
<!-- SECTION:FINAL_SUMMARY:END -->
