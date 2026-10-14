---
id: AISDLC-869
title: >-
  gitignore claude memory dream output so step 0.5 stops aborting every execute
status: To Do
assignee: []
created_date: '2026-10-14'
labels:
  - pipeline
  - reliability
  - chore
dependencies: []
references:
  - .gitignore
  - pipeline-cli/src/steps/00-5-sync-parent.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Claude Code memory consolidation ("dream") writes `.claude/memory.dream-<timestamp>.meta.json`, `.report.json`, `.report.md` and a `.claude/memory.dream-<timestamp>/` directory into the parent checkout, untracked. Step 0.5 (`pipeline-cli/src/steps/00-5-sync-parent.ts`) aborts every execute while the parent holds non-backlog untracked files. On 2026-10-14 this blocked AISDLC-469 (DEC-0214) and AISDLC-729 (DEC-0215). The planner added `.claude/memory.dream-*` to the parent's `.git/info/exclude` as an interim unblock; that is local to one clone and does not survive a re-clone or reach other contributors.

**Five-step review (requirements first).** Requirement questioned: "Step 0.5 must abort on any non-backlog untracked file in the parent, including tool-owned state under `.claude/`". The abort protects against stray work in a read-only parent; Claude Code's own memory output is not work and cannot be authored by an executor. The implementer decides whether Step 0.5 should ignore everything under `.claude/` by design (for example by deferring to git's standard ignore rules only, or by an explicit allowlist) and documents the choice in the PR body. Delete: nothing to delete beyond the manual per-incident escalation. Simplify: one `.gitignore` line, `.claude/memory.dream-*`, so Step 0.5 needs no special case (git already reports ignored files as not untracked). Accelerate: executors stop parking on a recurring, harmless artifact. Automate: the ignore rule is committed, so no planner or dispatch step re-adds it per clone.

## Fix

1. Add `.claude/memory.dream-*` to the root `.gitignore`.
2. Check that Step 0.5 (`pipeline-cli/src/steps/00-5-sync-parent.ts`) lists untracked files in a way that honours `.gitignore` (for example `git status --porcelain` without `--ignored`); add a test with a `memory.dream-*` file and directory in a temp parent proving Step 0.5 passes.
3. Decide and document whether anything else under `.claude/` should be exempt by design; if so, encode it once in Step 0.5 rather than adding per-pattern ignores.

## Acceptance Criteria

- [ ] #1 `.gitignore` contains `.claude/memory.dream-*` and `git status --porcelain` in a checkout holding those files reports nothing for them.
- [ ] #2 A Step 0.5 test with `.claude/memory.dream-<ts>.meta.json`, `.report.json`, `.report.md` and a `memory.dream-<ts>/` directory untracked in the parent passes (no abort).
- [ ] #3 A genuinely stray untracked file in the parent still aborts Step 0.5.
- [ ] #4 The PR body states whether Step 0.5 ignores `.claude/` by design and why.

**Velocity impact.** Positive: removes a recurring executor abort and a planner decision per occurrence.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, tightens nothing, no trust-chain control touched; DEC-0214 answered `gitignore`).
<!-- SECTION:DESCRIPTION:END -->
