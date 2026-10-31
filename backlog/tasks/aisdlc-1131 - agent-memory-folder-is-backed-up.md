---
id: AISDLC-1131
title: 'Agent memory folder is backed up: periodic copy outside the repo and a transcript-based rebuild command'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - memory
  - incident
  - operations
dependencies: []
references:
  - pipeline-cli/src/memory-dream/apply.ts
  - ai-sdlc-plugin/commands/memory-dream.md
  - docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md
priority: medium
dispatchable: true
---

## Description

`.claude/memory/` held about 90 operator-feedback and project notes, untracked and unignored. The 2026-10-30 deletion removed them; 45 were rebuilt by scanning session transcripts for `Write` and `Read` records, 61 survive only as their one-line index entries. The folder is the agents' institutional memory and had no copy anywhere; Time Machine's destination was unreachable and no APFS snapshot existed.

**Five-step review.**
1. Requirement questioned: should memory be tracked in git instead? It carries operator feedback that is not part of the product and churns per session; a backup, not a commit, fits.
2. Delete: nothing.
3. Simplify: the hierarchy tick (or `memory-dream run`) copies `.claude/memory/` to `~/.ai-sdlc/memory-backups/<repo-id>/<date>/` daily, keeping fourteen; one command rebuilds from transcripts the way the incident recovery did.
4. Accelerate: a plain directory copy.
5. Automate: `cli-hierarchy up` warns when the memory folder is empty but a backup exists.

Velocity impact: neutral.

## Acceptance Criteria

- [ ] AC-1: Daily copy of `.claude/memory/` to `~/.ai-sdlc/memory-backups/<repo-id>/<YYYY-MM-DD>/`, rotation keeps fourteen; implemented in the tick's parent upkeep or `memory-dream`, with tests.
- [ ] AC-2: `cli-memory-dream recover --from-transcripts <projects-dir>` rebuilds notes from `Write`/`Edit`/`Read` tool records in session transcripts into a reviewable folder (same apply/undo flow as `memory-dream`), and reports which index entries have no recoverable body.
- [ ] AC-3: `cli-hierarchy up` prints a one-line warning when `.claude/memory/MEMORY.md` is missing and a backup exists.
- [ ] AC-4: `docs/operations/` documents the backup location and the recover command, linked from the incident record.

## Notes

Origin: incident record 2026-10-30, follow-up list. The 61 unrecovered notes are listed by name in MEMORY.md; AC-2's report should name them.
