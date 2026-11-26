---
id: AISDLC-1412
title: 'Worktree sweep removes only registered worktrees'
status: In Progress
assignee: []
created_date: '2026-11-25'
labels:
  - bug
  - pipeline-cli
  - data-loss
dependencies: []
references:
  - pipeline-cli/src/steps/00-sweep.ts
priority: high
---

## Description

**Five-step review (requirements first).** The requirement: the sweep removes worktrees this repository created and nothing else. Today `sweepMergedWorktrees` in `pipeline-cli/src/steps/00-sweep.ts` treats every directory entry under `.worktrees/` as a worktree and can delete one that is not.

Three facts in the code (line numbers approximate):

- Pass 1 uses `statSync` (line 361), which follows symlinks, and checks only `isDirectory()`. A symlink to a directory passes, and the directory age comes from the link's target.
- The branch comes from `git -C <entry> rev-parse --abbrev-ref HEAD` (line 370). For a symlink into a sibling checkout this reports that other repository's branch. For a plain folder that is not a repository, git walks up and reports the parent repository's own branch. Either way a non-worktree gets a branch name and a PR lookup.
- `removeWorktree` (line 289) falls back to `rmSync(wt, { recursive: true, force: true })` plus `git worktree prune` whenever `git worktree remove --force` refuses. Git refuses a path that is not a registered worktree, so the fallback is exactly what runs for a non-worktree.

Reported by the enterprise planner session on 2026-11-25 against pipeline-cli 0.44.0: in an adopter repository, `ln -s ../../ai-sdlc .worktrees/ai-sdlc` was deleted by the tick sweep within about 30 seconds, twice. In that case only the link was removed. A plain folder or a clone placed under `.worktrees/`, with an old modification time and no open PR for the branch it reports, would be deleted recursively with any uncommitted work in it.

- **Delete:** the recursive-delete fallback is removed for any path git does not list as a worktree of this repository. It stays for a registered worktree whose directory git cannot remove.
- **Simplify:** one source of truth for "is a worktree": `git worktree list --porcelain` run in the repository. No name or path heuristics.
- **Accelerate / automate:** not applicable.

## Fix

- Build the set of registered worktree paths once per sweep from `git worktree list --porcelain` in `opts.workDir`. Compare resolved real paths.
- In pass 1, use `lstatSync` and skip symlinks. Skip any entry whose path is not in the registered set. A skipped entry is not counted against the worktree cap.
- In `removeWorktree`, run the `rmSync` fallback only for a path in the registered set. For any other path, remove nothing, log one warning naming the path, and report it as kept.
- When `git worktree list` fails, the sweep removes nothing in that pass and logs why.
- Apply the same guard to both removal call sites (the `sweepOne` helper and the main loop).

## Acceptance Criteria

- [ ] #1 A symlink under `.worktrees/` that points to a directory, including another git checkout, survives a sweep; the link and its target are untouched.
- [ ] #2 A plain directory under `.worktrees/` that is not a git repository survives a sweep with its files intact.
- [ ] #3 A separate clone under `.worktrees/` that is not a registered worktree of the repository survives a sweep with uncommitted files intact.
- [ ] #4 A registered worktree whose PR is merged is still removed, and the fallback still clears a registered worktree that `git worktree remove --force` refuses.
- [ ] #5 When `git worktree list --porcelain` fails, no entry is removed and a warning is logged.
- [ ] #6 Entries that are not registered worktrees do not count toward the worktree cap and trigger no PR lookup.
- [ ] #7 Tests cover #1 to #5 using real temporary directories, not only a mocked runner.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
