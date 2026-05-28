---
id: AISDLC-406
title: 'feat(ci): restore merge-skew protection post queue-drop (main health monitor + alert)'
status: Done
labels: [ci, operator-merge, skew-protection, post-aisdlc-400]
references:
  - .github/workflows/ai-sdlc-gate.yml
  - CLAUDE.md
priority: high
permittedExternalPaths: []
---

## Description

AISDLC-400 dropped the GitHub merge queue + update-branch step in favor of direct parallel merges. The expected tradeoff: throughput up, skew detection down. The unexpected cost showed up immediately: AISDLC-398 + AISDLC-400 + AISDLC-405 had per-PR-green CI but combined to break main's test suite (AISDLC-405 was the cleanup PR that itself blocked 5 other PRs from merging).

This task ships a "main health monitor" workflow that runs the FULL test suite on every push to main + pages the operator when main goes red. This is the reactive complement to the no-queue direct-merge model.

## Acceptance criteria

- [ ] AC-1: New workflow `.github/workflows/main-health-monitor.yml` triggers on `push` to `main` (only main, no PR triggers). Runs the full pnpm test suite + the `.github/workflows/__tests__/` workflow-test suite (separate from per-package tests). Exit non-zero on any failure.
- [ ] AC-2: On failure, the workflow creates a GitHub issue titled `[main-health] main is RED at <commit>` with the failing test names + commit message + link to the failing commit. Issue is auto-assigned to `@deefactorial`.
- [ ] AC-3: Workflow uses `concurrency: { group: main-health-monitor, cancel-in-progress: false }` so each main push gets its own health check (no cancellation of mid-flight runs).
- [ ] AC-4: Operator runbook section at `docs/operations/main-health-monitor.md` (NEW): documents the alert flow, how to triage a red-main alert, how to quickly bisect which PR introduced the breakage (`git log --oneline` between the last green commit + the red commit).
- [ ] AC-5: CLAUDE.md "CI behavior" section updated: document the new monitor + its relationship to pr-ready (pr-ready = per-PR check; main-health-monitor = post-merge skew detector).
- [ ] AC-6: Reference the AISDLC-398 + AISDLC-400 + AISDLC-405 chain as the motivating incident.

## Out of scope

- Re-enabling the queue or conditional update-branch (operator chose D for throughput; this is the reactive complement)
- Auto-revert on red main (deferred; manual triage first, automation later if patterns emerge)
- Per-test skew root-cause analysis (the runbook tells the operator how to bisect manually)

## Estimated effort

1-2 hours.
