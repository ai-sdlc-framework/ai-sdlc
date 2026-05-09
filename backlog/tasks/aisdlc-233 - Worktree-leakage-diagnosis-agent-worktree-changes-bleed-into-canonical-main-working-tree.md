---
id: AISDLC-233
title: >-
  Worktree leakage diagnosis — agent worktree changes bleed into canonical
  main working tree
status: To Do
assignee: []
created_date: '2026-05-07 21:35'
labels:
  - bug
  - worktree
  - pattern-c
  - dogfood
  - investigation
dependencies: []
priority: high
dispatchable: false
dispatchableReason: >-
  Investigation/diagnosis task — requires operator to reproduce and observe
  the leakage pattern interactively. No standalone code fix can be developed
  without first understanding the root cause through operator observation.
references:
  - CLAUDE.md
  - pnpm-workspace.yaml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Operators report that mid-flight changes from agent worktrees (`.worktrees/<task-id>/`) appear as MODIFIED files in the canonical main working tree (`<repo-root>/`), forcing repeated `git stash` cycles before any work in the parent.

Witnessed (Alex on the forge repo, 2026-05-07):

> "Worktree leakage into canonical main directory. Agents in /Users/adminster/forge/.claude/worktrees/agent-XXX are bleeding partial mid-flight changes into the parent /Users/adminster/forge working tree. Forced 5+ stash cycles. Symptom: `git status` in canonical main shows MODIFIED files from agents I never touched."

> "Pre-push build failures from leaked partial state. When leakage hits packages/shared/, pre-push runs build → fails on incomplete code. Forces stash → push → pop workaround before every push."

This is the Pattern C contract being violated. Per CLAUDE.md AISDLC-216:

> "In Pattern C (non-bare parent repo + .worktrees/<task-id>/ isolates), the parent's working tree is read-only."

Pattern C's whole reason for existing is to make the parent working tree a read-only contract. Leakage breaks that.

## Suspected root causes (must investigate)

1. **pnpm/turbo cache pointing back at parent** — Alex's hypothesis. pnpm hoists `node_modules` to a workspace root; if the worktree's `pnpm-workspace.yaml` resolves to the parent's workspace, build artifacts may write to parent paths.
2. **Build artifacts under `dist/`** — pipeline-cli's `tsc -p tsconfig.build.json` writes to `dist/`. If a worktree's tsc resolves outputDir to a parent-relative path, dist appears in parent. Pre-push hooks rebuild → potentially leak.
3. **Hooks running with parent cwd** — husky hooks may invoke commands with the parent's cwd if hook resolution lands at the worktree's `.git` (which IS in `<parent>/.git/worktrees/<id>/`, NOT in the worktree directory itself).
4. **Symlinks across worktrees** — pnpm creates symlinks for workspace packages. If a worktree symlinks back to a parent path, edits via the symlink appear as parent edits.
5. **Tools that resolve repo-root via `.git` directory location** — `git rev-parse --show-toplevel` from inside a worktree returns the worktree path; some tools resolve from `.git/` location which IS the parent's `.git/worktrees/<id>/`.

## Proposed approach

### Phase 1: Reproduce + instrument (this task)

1. Set up a reproducible test case: dispatch 1 task via orchestrator OR Agent path, observe `git status` in parent before/during/after the dev runs
2. If leakage reproduces, inspect:
   - `git status --porcelain` in parent at each phase (launch / mid-dev / pre-push / post-push)
   - `find <parent> -newer .reference-timestamp -type f` to identify which files are touched
   - `lsof` on the suspected files during dev runtime to find which process owns the writes
   - Check pnpm's `node_modules` for symlinks pointing across `worktrees/` boundary
3. Document findings + propose Phase 2 fix in this task

### Phase 2: Fix (separate task once root cause known)

Likely candidates:
- Override pnpm's symlink resolution to keep `node_modules/.pnpm/` per-worktree
- Configure tsc to use absolute outputDir paths
- Lock husky hooks to worktree cwd via explicit `cd` in hook scripts
- Add a pre-push assertion: parent's `git status` MUST be clean (catches leakage at the gate)

## Acceptance Criteria

- [ ] #1 Test fixture / runbook documenting how to reproduce the leakage (which dispatch path, which files leak, in what phase)
- [ ] #2 Process-attribution diagnostic: identify which subprocess (claude -p? pnpm install? tsc? husky hook?) owns the stray writes via `lsof` or `fs_usage` + log capture
- [ ] #3 Audit pnpm-workspace.yaml + per-package package.json for any path that could cause cross-worktree symlinking; document the Pattern C-correct configuration if it differs from what's shipped
- [ ] #4 Audit tsc + vitest + prettier configs for relative outputDir / cacheDir settings that could resolve to parent paths from a worktree
- [ ] #5 Audit husky hook scripts (`scripts/check-*.sh`) for any cwd assumption that might land at parent rather than worktree (`git rev-parse --show-toplevel` discrepancy is the canonical trap)
- [ ] #6 Filed follow-up tasks for each root cause identified (Phase 2 work) — this task itself is the diagnosis container
- [ ] #7 Operator runbook updated at `docs/operations/orchestrator-runbook.md` with the diagnostic recipe + interim mitigation (e.g., "if you see leakage, check X first")

## Composes with

- **AISDLC-228** (Step 3 quarantine guard) — different symptom (worktree cleanup vs parent leakage) but same root concern (Pattern C contract violations from orchestrator-spawned subprocesses)
- **AISDLC-231 / AISDLC-232** (parallel-orchestrator-safety batch) — leakage compounds the rebase-fan-out cost; fixing it makes the safety batch's effects more reliable

## References

- `CLAUDE.md` Pattern C section (AISDLC-216) — defines the read-only contract
- `pnpm-workspace.yaml` — workspace config that may need per-worktree adjustment
- `pipeline-cli/tsconfig.build.json` — tsc outputDir candidate
- `scripts/check-*.sh` — husky hook scripts, cwd discipline candidate
- Operator's "ai-sdlc plugin feedback for Dom.md" 2026-05-07 — Alex's primary report
- AISDLC-228 (sister Pattern C concern — Step 3 quarantine)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Reproducible test fixture / runbook for the leakage symptom
- [ ] #2 Process-attribution diagnostic identifies which subprocess owns stray writes
- [ ] #3 pnpm-workspace + package.json audit for cross-worktree symlink risk
- [ ] #4 tsc + vitest + prettier config audit for relative outputDir / cacheDir
- [ ] #5 husky hook script audit for cwd assumption traps
- [ ] #6 Phase 2 follow-up tasks filed per root cause identified
- [ ] #7 Operator runbook updated with diagnostic recipe + interim mitigation
<!-- SECTION:ACCEPTANCE:END -->
