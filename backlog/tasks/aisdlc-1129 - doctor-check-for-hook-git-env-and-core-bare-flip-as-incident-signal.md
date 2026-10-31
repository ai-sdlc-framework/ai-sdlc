---
id: AISDLC-1129
title: 'Doctor check for GIT_DIR in hook environments, and a core.bare flip on the parent becomes an incident signal instead of a silent self-heal'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - doctor
  - hooks
  - incident
  - governance
dependencies: []
references:
  - scripts/check-orchestrator-state.sh
  - ai-sdlc-plugin/commands/doctor.md
  - .husky/pre-push
  - .husky/pre-commit
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md
priority: high
dispatchable: true
---

## Description

Two signals were available before the 2026-10-30 deletion and both were muted. `check-orchestrator-state.sh` has auto-corrected `core.bare=true` on the parent "from time to time" since AISDLC-137; that flip was the same `GIT_DIR` leak at small scale and was logged as a nuisance. And no check ever looked at what environment a git hook hands its children. This task turns both into things the system reports.

**Five-step review.**
1. Requirement questioned: should the self-heal stay? Yes, repair is right; silence is the problem.
2. Delete: nothing.
3. Simplify: (a) `check-orchestrator-state.sh` records every `core.bare` or off-main correction as a Decision Catalog escalation (`cli-decisions escalate --scope parent-checkout`) with the command that likely caused it, instead of only echoing a WARN; (b) one doctor check, `hook-env-hygiene`, that runs each husky hook's preamble under `sh` with `GIT_DIR` set and reports any hook whose first gate still sees it.
4. Accelerate: the doctor check is a sub-second shell run.
5. Automate: add a prompt rule in `prompt-rules.js` for reviewers: a change that spawns processes from a git hook must state how it handles `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX`.

Velocity impact: neutral.

## Acceptance Criteria

- [ ] AC-1: `ai-sdlc doctor` gains `hook-env-hygiene`; it fails when any `.husky/*` hook's preamble (up to its first gate command) leaves `GIT_DIR` or `GIT_WORK_TREE` set, and passes on current `main` once the incident fix is merged.
- [ ] AC-2: `check-orchestrator-state.sh` writes a catalog escalation on every `core.bare` correction and every off-main recovery (scope `parent-checkout`), naming the parent HEAD before and after; the tick surfaces it like any escalation. Test with the existing script test file.
- [ ] AC-3: A reviewer prompt rule (one source, `prompt-rules.js`) requires hook-spawned processes to declare their git-environment handling; rendered into the code and security reviewer prompts by the existing sync.
- [ ] AC-4: `docs/operations/incidents/README.md` ledger row for the `GIT_DIR` leak points at the doctor check as "addressed by".

## Notes

Origin: incident record 2026-10-30, follow-up list.
