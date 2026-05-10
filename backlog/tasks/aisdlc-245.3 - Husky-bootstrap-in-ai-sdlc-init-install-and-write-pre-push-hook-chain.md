---
id: AISDLC-245.3
title: >-
  Phase 3: Husky bootstrap in /ai-sdlc init — install + write pre-push hook
  chain
status: To Do
assignee: []
created_date: '2026-05-08 12:10'
labels:
  - adoption
  - plugin
  - init
  - hooks
  - phase-3
parentTaskId: AISDLC-245
dependencies:
  - AISDLC-245.2
priority: high
references:
  - .husky/pre-push
  - ai-sdlc-plugin/scripts/init.mjs
  - scripts/check-coverage.sh
  - scripts/check-task-moved.sh
  - scripts/check-attestation-sign.sh
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem
Adopter repos don't have husky installed. The pre-push hook chain
(coverage → task-move → attestation-sign) is the canonical safety gate per
CLAUDE.md, but it requires husky to be installed and `.husky/pre-push` to
exist. `/ai-sdlc init` should bootstrap this.

## Acceptance Criteria

- [ ] #1 `/ai-sdlc init` runs `npm install --save-dev husky` (or `pnpm add -D husky`) when husky is not already in adopter's `package.json` devDependencies
- [ ] #2 Init runs `husky install` (or equivalent for current husky version) to set up `.husky/` directory
- [ ] #3 Init writes `.husky/pre-push` with the canonical chain: `scripts/check-coverage.sh && scripts/check-task-moved.sh && scripts/check-attestation-sign.sh` (matching the framework's chain order — load-bearing, see CLAUDE.md "Hooks" section)
- [ ] #4 If adopter already has `.husky/pre-push` with different content, init refuses to overwrite without `--force` and prints a diff explaining what would change
- [ ] #5 Hermetic test: empty fixture project + `/ai-sdlc init` + verify `.husky/pre-push` exists, executable, contains the canonical chain
- [ ] #6 Hermetic test: adopter with pre-existing `.husky/pre-push` + `/ai-sdlc init` (no --force) → exits non-zero with clear diff message
- [ ] #7 Operator runbook documents the husky bootstrap + how to extend the hook chain with adopter-specific gates
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Init installs husky as devDep when absent
- [ ] #2 Init runs husky install to set up .husky/
- [ ] #3 Init writes .husky/pre-push with canonical chain in correct order
- [ ] #4 Refuses overwrite of existing .husky/pre-push without --force; prints diff
- [ ] #5 Hermetic test: fresh init produces working pre-push
- [ ] #6 Hermetic test: existing pre-push refused without --force
- [ ] #7 Adopter runbook documents bootstrap + extension
<!-- SECTION:ACCEPTANCE:END -->
