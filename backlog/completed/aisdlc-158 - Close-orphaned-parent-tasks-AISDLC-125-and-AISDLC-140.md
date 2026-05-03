---
id: AISDLC-158
title: Close orphaned parent tasks AISDLC-125 + AISDLC-140
status: Done
assignee: []
created_date: '2026-05-02'
updated_date: '2026-05-02'
labels:
  - chore
  - backlog
  - cleanup
dependencies: []
references:
  - backlog/completed/aisdlc-125 - Bulk-clean-297-backlog-drift-issues-promote-gate-from-advisory-to-required.md
  - backlog/completed/aisdlc-140 - RFC-implementation-Quality-Gate-Redesign-single-pr-ready-aggregator-audit-only-attestation.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two parent tasks had all their substantive sub-PRs merged but their canonical task files were stale. The frontier CLI surfaced them on the operator's stale parent-repo working tree, but at HEAD their state was already partially correct:

- **AISDLC-125** — was already in `backlog/completed/` at HEAD (`status: Done`, full Final Summary), moved by commit `9c92172` ("promote backlog-drift gate from advisory to required"). The task brief was authored from a stale working-tree snapshot. No edit needed at HEAD.
- **AISDLC-140** — never tracked as a backlog file in git history despite the operator having an untracked working-tree copy in `backlog/tasks/`. Sub-1 shipped via PR #184; sub-4 shipped via PR #183; the remaining sub-tasks were retired by the redesign itself. This task creates the closure file directly in `backlog/completed/`.

This is a chore meta-cleanup — no implementation work, only closure files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 AISDLC-140 closure file lives at `backlog/completed/` with `status: Done`, `updated_date`, and a Final Summary documenting PR #183 + PR #184
- [x] #2 AISDLC-125 already correct at HEAD (`status: Done`, Final Summary present) — no edit required
- [x] #3 `node pipeline-cli/bin/cli-deps.mjs frontier --format table --work-dir .` does not list AISDLC-125 or AISDLC-140
- [x] #4 `npx backlog-drift@0.1.3 check` exits 0 (no new error-severity drift)
- [x] #5 AISDLC-158 ships straight to `backlog/completed/` (chore-meta scope, single trivial PR)
<!-- AC:END -->

## Final Summary

### Summary
Created the AISDLC-140 closure file in `backlog/completed/` documenting the merged sub-PRs (#183 audit-only attestation, #184 pr-ready aggregator) and the retired sub-tasks. AISDLC-125 was already correctly closed at HEAD by commit `9c92172`, so no edit was needed for that file. This AISDLC-158 file is the meta-closure record.

### Changes
- `backlog/completed/aisdlc-140 - RFC-implementation-Quality-Gate-Redesign-single-pr-ready-aggregator-audit-only-attestation.md` (new): closure record for the quality-gate redesign parent. Status Done, Final Summary references PRs #183 and #184, retired-patches list preserved for audit.
- `backlog/completed/aisdlc-158 - Close-orphaned-parent-tasks-AISDLC-125-and-AISDLC-140.md` (new): this file.

### Design decisions
- **AISDLC-125 left untouched** — at HEAD the file is already in `backlog/completed/` with `status: Done`, `updated_date`, full Final Summary, and all 8 ACs checked. The task brief described editing a `backlog/tasks/aisdlc-125 ...md` file, but no such tracked file exists at HEAD; the brief was authored against the operator's stale parent-repo working tree (which still had the pre-`9c92172` `tasks/` copy untracked on disk). Editing the already-complete file would be churn, so it was left as-is.
- **AISDLC-140 created, not git-mv'd** — the file was never tracked in any git history (verified via `git log --all -- 'backlog/tasks/aisdlc-140*'` returning empty). The brief assumed a `git mv` would work; instead the closure file is created directly in `completed/`.
- **AISDLC-158 ships straight to `completed/`** — explicit per the brief; this is a single-PR chore meta-cleanup with no separate review-and-promote cycle warranted.

### Verification
- `node pipeline-cli/bin/cli-deps.mjs frontier --format table --work-dir .` — neither AISDLC-125 nor AISDLC-140 appears
- `npx backlog-drift@0.1.3 check` — exit 0 (no new drift)

### Follow-up
- (none) — both parent tasks are now in `backlog/completed/` with proper closure summaries.
