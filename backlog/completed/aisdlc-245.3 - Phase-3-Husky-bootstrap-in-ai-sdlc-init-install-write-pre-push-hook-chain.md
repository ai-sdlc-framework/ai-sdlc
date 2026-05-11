---
id: AISDLC-245.3
title: >-
  Phase 3: Husky bootstrap in /ai-sdlc init — install + write pre-push hook
  chain
status: Done
assignee: []
created_date: '2026-05-08 12:10'
updated_date: '2026-05-10 14:57'
labels:
  - adoption
  - plugin
  - init
  - hooks
  - phase-3
dependencies:
  - AISDLC-245.2
references:
  - .husky/pre-push
  - scripts/check-coverage.sh
  - scripts/check-task-moved.sh
  - scripts/check-attestation-sign.sh
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Operator decision (2026-05-10)

**(B) Detect husky + offer to install if missing — operator decision 2026-05-10.** Init checks for `.husky/`; if present, appends to `pre-push`. If missing, prompts `Install husky? [Y/n]`. `--yes` flag for non-interactive (CI scaffolding).

## Problem
Adopter repos don't have husky installed. The pre-push hook chain
(coverage → task-move → attestation-sign) is the canonical safety gate per
CLAUDE.md, but it requires husky to be installed and `.husky/pre-push` to
exist. `/ai-sdlc init` should bootstrap this.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 #1 `/ai-sdlc init` runs `npm install --save-dev husky` (or `pnpm add -D husky`) when husky is not already in adopter's `package.json` devDependencies
- [ ] #2 #2 Init runs `husky install` (or equivalent for current husky version) to set up `.husky/` directory
- [ ] #3 #3 Init writes `.husky/pre-push` with the canonical chain: `scripts/check-coverage.sh && scripts/check-task-moved.sh && scripts/check-attestation-sign.sh` (matching the framework's chain order — load-bearing, see CLAUDE.md "Hooks" section)
- [ ] #4 #4 If adopter already has `.husky/pre-push` with different content, init refuses to overwrite without `--force` and prints a diff explaining what would change
- [ ] #5 #5 Hermetic test: empty fixture project + `/ai-sdlc init` + verify `.husky/pre-push` exists, executable, contains the canonical chain
- [ ] #6 #6 Hermetic test: adopter with pre-existing `.husky/pre-push` + `/ai-sdlc init` (no --force) → exits non-zero with clear diff message
- [ ] #7 #7 Operator runbook documents the husky bootstrap + how to extend the hook chain with adopter-specific gates
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #8 #1 Init installs husky as devDep when absent
- [ ] #9 #2 Init runs husky install to set up .husky/
- [ ] #10 #3 Init writes .husky/pre-push with canonical chain in correct order
- [ ] #11 #4 Refuses overwrite of existing .husky/pre-push without --force; prints diff
- [ ] #12 #5 Hermetic test: fresh init produces working pre-push
- [ ] #13 #6 Hermetic test: existing pre-push refused without --force
- [ ] #14 #7 Adopter runbook documents bootstrap + extension
<!-- SECTION:ACCEPTANCE:END -->
<!-- AC:END -->

## Final Summary

**Closed: deferred per operator decision, 2026-05-10 ("stays opt-in").**

The husky-bootstrap path was deferred indefinitely. Adopters who want pre-push gates configure husky themselves; the plugin-resolved scripts (AISDLC-245.4) make the gate scripts available, but the install-side wiring is the adopter's call.

If a future cohort of adopters needs zero-config pre-push, reopen this task or file a new one.
