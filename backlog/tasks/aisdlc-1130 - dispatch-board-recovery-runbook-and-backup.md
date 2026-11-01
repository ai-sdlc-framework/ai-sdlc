---
id: AISDLC-1130
title: 'Dispatch board recovery: rebuild .ai-sdlc/dispatch from GitHub PR state, and a periodic board backup'
status: In Progress
assignee: []
created_date: '2026-10-31'
labels:
  - hierarchy
  - dispatch
  - incident
  - operations
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - docs/operations/cli-hierarchy.md
  - docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md
priority: high
dispatchable: true
---

## Description

The 2026-10-30 deletion took the whole dispatch board with it: 446 done and 30 failed verdicts, open briefs, inflight manifests, PR snapshot and handoffs, all under the gitignored `.ai-sdlc/dispatch/`. Nothing could restore it; the hierarchy must be rebuilt from GitHub and `backlog/` by hand. The board is the one piece of runtime state the system cannot regenerate on its own, and it had no copy anywhere.

**Five-step review.**
1. Requirement questioned: does the board need to survive a disk loss? The verdicts drive done/landed semantics and the closed-PR KPI; yes.
2. Delete: nothing.
3. Simplify: (a) a `cli-dispatch rebuild --from-github` that derives queue/inflight/done/failed from open and merged PRs with task ids in their titles plus `backlog/tasks` vs `backlog/completed`, writing verdicts marked `rebuilt: true`; (b) the tick copies the board to `~/.ai-sdlc/board-backups/<repo-id>/<date>.tar.gz` once a day, keeping seven.
4. Accelerate: rebuild reads one PR list call (quota-aware, AISDLC-963 floor).
5. Automate: `cli-hierarchy up` offers the rebuild when the board directory is empty but `backlog/completed/` is not.

Velocity impact: positive after a loss, neutral otherwise.

## Acceptance Criteria

- [ ] AC-1: `cli-dispatch rebuild --from-github --board-dir <dir>` writes done verdicts for merged task PRs, failed/queued entries for open ones by state, and reports counts; dry-run prints without writing.
- [ ] AC-2: The dispatch tick writes a daily board backup under `~/.ai-sdlc/board-backups/`, keeps the last seven, and `cli-dispatch restore --backup <file>` restores one.
- [ ] AC-3: `cli-hierarchy up` detects an empty board beside a non-empty `backlog/completed/` and prints the rebuild command (never runs it unasked).
- [ ] AC-4: Runbook `docs/operations/board-recovery.md`, linked from the incident record and `cli-hierarchy.md`.
- [ ] AC-5: Vitest covers rebuild classification, backup rotation and the up-time hint.

## Notes

Origin: incident record 2026-10-30, follow-up list. First use: rebuilding the board lost on 2026-10-30 once the incident fix is on main.
