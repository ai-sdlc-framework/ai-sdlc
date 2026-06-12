---
id: AISDLC-517
title: 'fix(orchestrator): resolve implicit-any (TS7006) in webhook-manager.ts surfaced on fresh-worktree typecheck'
status: Done
assignee: []
created_date: '2026-06-04'
labels:
  - orchestrator
  - bug
  - follow-up
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
During two RFC-0043 Phase 7 reconciles (AISDLC-513 and AISDLC-514), a fresh-worktree
`pnpm -r --parallel exec tsc --noEmit` reported a TS7006 (implicit-any) error in
`orchestrator/src/webhook-manager.ts`. It reproduced before any task changes and is
unrelated to those PRs. Building the orchestrator first (`pnpm --filter @ai-sdlc/orchestrator build`)
cleared the typecheck, so the symptom is build-order/stale-dist sensitive rather than a
hard type break — `main-health-monitor` was green throughout. This task is to pin down
the real cause and make the typecheck robust regardless of build order.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Reproduce the TS7006 on a clean checkout without a prior orchestrator build; capture the exact parameter/line.
- [ ] #2 Add an explicit type annotation (or the correct import) so the parameter is no longer implicitly `any`.
- [ ] #3 `pnpm -r --parallel exec tsc --noEmit` is clean on a fresh worktree with no pre-build step.
- [ ] #4 `pnpm --filter @ai-sdlc/orchestrator build && pnpm --filter @ai-sdlc/orchestrator test` clean; patch coverage >= 80% on any changed source.
<!-- AC:END -->

## Notes

Low blast radius (single annotation likely). Surfaced during the RFC-0043 Phase 7 drain.
