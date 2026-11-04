---
id: AISDLC-1182
title: 'Untrack the .claude/memory notes from the public repo and gitignore the folder'
status: In Progress
assignee: []
created_date: '2026-11-04'
labels:
  - memory
  - privacy
  - chore
dependencies: []
references:
  - .gitignore
  - scripts/gitignore-claude-state.test.mjs
  - scripts/is-docs-only-changeset.mjs
  - pipeline-cli/attestation-core/docs-only-paths.mjs
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/memory-dream/backup.ts
  - docs/operations/cli-hierarchy.md
  - docs/operations/system-of-record.md
priority: high
---

## Description

**Source.** Operator direction in the ai-sdlc planner session, 2026-11-04: "`.claude/memory` contains public memories; the directory should be git ignored and those memories should be removed from the public repo." Recorded as DEC-0370, option `untrack-and-private-backup`. This reverses the tracking half of AISDLC-1136 (PR #2212).

**Problem.** PR #2212 committed 41 agent memory notes (`MEMORY.md`, `feedback_*`, `project_*`, `reference_*` and unprefixed rules) under `.claude/memory/`, so they are public on GitHub. AISDLC-1136 tracked them because the 2026-10-30 incident lost untracked notes. The AISDLC-1131 daily backup was meant to cover that risk, but `cli-hierarchy up` backs up `resolveMemoryDir()`, which resolves to `~/.claude/projects/<slug>/memory`, not the repo's `.claude/memory/`. So once untracked, the repo notes would have no backup. The planner took a one-off manual backup on 2026-11-04 to `~/.ai-sdlc/memory-backups/ai-sdlc-88c9237a/2026-11-04/` (all 41 tracked notes present).

**Out of scope.** Rewriting git history to purge the notes from past commits. That needs a force-push to `main` and is the operator's separate decision; do not attempt it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: AISDLC-1136 required the notes to be tracked so a lost checkout could not lose them; the operator now rules the repo is public and the notes must not be in it, so the durability requirement moves to a private backup. 2. Deleted: the 41 tracked notes (`git rm --cached`, files kept on disk) and the four AISDLC-1136 per-pattern ignore lines, replaced by one `.claude/memory/` rule. 3. Simplified: one ignore rule for the whole folder; the docs-only and steering path lists drop `.claude/memory/` since nothing there can be committed. 4. Accelerated: no memory-note PRs through the docs lane. 5. Automated: the daily backup covers the repo folder.

## Acceptance Criteria

- [ ] AC-1: Every file under `.claude/memory/` is removed from the index with `git rm --cached` (working files kept), and `.gitignore` ignores `.claude/memory/` with a comment citing DEC-0370. The AISDLC-1136 lines for that folder are replaced, not duplicated.
- [ ] AC-2: `scripts/gitignore-claude-state.test.mjs` asserts that durable notes such as `.claude/memory/MEMORY.md` ARE ignored, replacing the AISDLC-1136 "does not ignore durable memory notes" assertion.
- [ ] AC-3: The daily backup taken by `cli-hierarchy up` also copies the repo `.claude/memory/` folder when it exists, to a distinct path under `~/.ai-sdlc/memory-backups/<repo-id>/`, with a test. The existing auto-memory backup keeps working.
- [ ] AC-4: References to `.claude/memory/` as committed or committable are updated: `docs/operations/cli-hierarchy.md` ("Committed versus regenerated", the steering path list), `docs/operations/system-of-record.md`, and the path lists in `scripts/is-docs-only-changeset.mjs` and `pipeline-cli/attestation-core/docs-only-paths.mjs` with their tests.
- [ ] AC-5: The PR body warns that fast-forwarding a checkout past this commit deletes its local `.claude/memory/` notes, because git removes files a pulled commit untracks, and gives the restore command from the backup (`cp -n ~/.ai-sdlc/memory-backups/<repo-id>/<date>/*.md .claude/memory/`).
