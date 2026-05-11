---
id: AISDLC-245.2
title: 'Phase 2: Vendor shell scripts via /ai-sdlc init into adopter repo'
status: Done
assignee: []
created_date: '2026-05-08 12:10'
updated_date: '2026-05-10 14:57'
labels:
  - adoption
  - plugin
  - init
  - phase-2
dependencies:
  - AISDLC-245.1
references:
  - scripts/check-orchestrator-state.sh
  - scripts/check-attestation-sign.sh
  - scripts/check-task-moved.sh
  - scripts/check-coverage.sh
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Operator decision (2026-05-10)

**(B) Plugin-resolved (no vendoring) — operator decision 2026-05-10.** Pre-push hook calls scripts from `node_modules/@ai-sdlc/plugin/scripts/`, no vendoring into adopter repo. Updates ship via npm.

## Problem
Shell scripts (orchestrator state-check, hook gates) live in the framework
repo's `scripts/` directory. Adopters need their own copies under
`<adopter-repo>/scripts/` so the plugin commands and pre-push hooks can invoke
them via stable relative paths.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 #1 `/ai-sdlc init` writes `scripts/check-orchestrator-state.sh`, `scripts/check-attestation-sign.sh`, `scripts/check-task-moved.sh`, `scripts/check-coverage.sh` (plus any other shell scripts the slash command body invokes) into the adopter repo
- [ ] #2 #2 Vendored scripts are operator-resolvable: same exit codes, same env-var skip flags (AI_SDLC_SKIP_*), same idempotency contracts as framework versions
- [ ] #3 #3 Scripts ship with `chmod +x` set so husky can invoke them without permission errors
- [ ] #4 #4 `/ai-sdlc init` is idempotent — re-running on existing adopter repo updates scripts to current plugin version, preserves any operator-local additions in scripts/ (warn on conflict, never overwrite without `--force`)
- [ ] #5 #5 Hermetic test: empty fixture project + `/ai-sdlc init` + assert each script exists, executable, prints expected version banner
- [ ] #6 #6 Operator runbook (`docs/operations/adopter-onboarding.md`) documents the upgrade flow when plugin version bumps the scripts
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #7 #1 /ai-sdlc init writes all required scripts/ shell files into adopter repo
- [ ] #8 #2 Vendored scripts behaviorally match framework versions (exit codes, skip flags, idempotency)
- [ ] #9 #3 Scripts ship with chmod +x set
- [ ] #10 #4 Init idempotent + safe on re-run; warns on operator-edited conflicts
- [ ] #11 #5 Hermetic test: fixture project init + script resolution
- [ ] #12 #6 Adopter onboarding runbook documents upgrade flow
<!-- SECTION:ACCEPTANCE:END -->
<!-- AC:END -->

## Final Summary

**Closed: superseded by operator decision (B), 2026-05-10.**

Operator chose **plugin-resolved (no vendoring)**: pre-push hook scripts run from `node_modules/@ai-sdlc/plugin/scripts/` and updates ship via npm. The vendoring approach this task was scoped to is no longer the chosen path.

The plugin-resolved path was implemented by AISDLC-245.4 (slash commands resolve via `$CLAUDE_PLUGIN_DIR`). Adopters get the canonical scripts via `@ai-sdlc/pipeline-cli` npm package + the plugin's bundled scripts directory — no per-repo vendoring needed.

If the operator ever reverses and wants vendored scripts, this task should be reopened with a fresh design (or a new task filed).
