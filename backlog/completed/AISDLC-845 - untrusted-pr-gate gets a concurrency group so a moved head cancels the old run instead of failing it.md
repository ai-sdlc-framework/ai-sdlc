---
id: AISDLC-845
title: >-
  untrusted-pr-gate gets a concurrency group so a moved head cancels the old run instead of failing it
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
dependencies: []
references:
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/__tests__/untrusted-pr-gate.test.mjs
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`untrusted-pr-gate.yml` had 336 of 1000 runs fail in 7 days; 20 of 20 sampled failures are the `Governance boundary` job exiting 1 on the race guard ("PR head moved ... a newer run will re-evaluate"), after which a `failure` commit status reading "a fork changes governance config or workflows" lands on the old SHA. The workflow has no `concurrency` group, so each push leaves a failing superseded run (`docs/audits/2026-10-13-cicd-five-step-audit.md`, finding F6).

**Five-step review (requirements first).** Requirement questioned: "a superseded run must report failure" (the race guard was written to refuse stale heads, not to mark them failed). Delete: the failing outcome of a superseded run. Simplify: a `concurrency` group per PR with `cancel-in-progress: true`, and the race-guard path exits neutral and posts no failure status. Accelerate: removes 336 false failures a week and the runs that produce them. Automate: nothing new. Not a weakening: the current head is still evaluated in full. Coordinate with the open fork-only change (AISDLC-799): if it lands first, rebase and keep both.

## Fix

1. Add `concurrency: { group: untrusted-${{ github.event.pull_request.number }}, cancel-in-progress: true }` to `.github/workflows/untrusted-pr-gate.yml`.
2. In the race-guard step of `Governance boundary`, when the head has moved: exit 0 (neutral) and do not post the `failure` commit status for the old SHA; keep failing when the head is current and the boundary check really fails.
3. Update `.github/workflows/__tests__/untrusted-pr-gate.test.mjs` to assert the concurrency group and that the superseded path posts no failure status.

**Velocity impact.** Positive: removes 336 false failures a week and the superseded runs behind them; the current head is still fully evaluated.

Authority: class (a) decision under `docs/operations/decision-authority.md` (reversible, non-weakening, derived from the 2026-10-13 audit; no decision record required).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `untrusted-pr-gate.yml` has a per-PR `concurrency` group with `cancel-in-progress: true`
- [ ] #2 The head-moved race guard exits 0 and posts no `failure` commit status; a genuine boundary violation on the current head still fails
- [ ] #3 `untrusted-pr-gate.test.mjs` asserts both and `node --test .github/workflows/__tests__/` passes
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
