---
name: repo-deletion-2026-10-30
description: "The parent checkout and all 45 worktrees were deleted on 2026-10-30 23:57Z-00:05Z; what was lost, what was restored, and the suspected cause"
metadata:
  node_type: memory
  type: project
  originSessionId: 148b7e70-ff0c-4b4c-b070-b3c408f73012
  modified: 2026-10-31T00:17:39.860Z
---

On 2026-10-30 between 23:57Z and 00:05Z the whole working tree at `Documents/dev/ai-sdlc/ai-sdlc` (parent `.git`, every tracked file, all 45 worktrees under `.worktrees/`) was deleted in lexical order by a recursive delete that no Claude session issued (all transcripts checked). Minutes before, the parent had been put on the AISDLC-1123 branch and flagged `core.bare=true`, while the AISDLC-785 executor's push ran the new pre-push patch-coverage gate (AISDLC-1119, landed #2168 that afternoon), which executes `pnpm --filter ./pipeline-cli test:coverage` inside a linked worktree. Git exports `GIT_DIR` to hooks in a linked worktree; `.husky/pre-push` does not unset it, and 81 of 87 pipeline-cli tests that spawn git do not use `makeGitEnv()`. Several of those tests toggle `core.bare`, check out branches and `git worktree remove --force` or `rmSync` their fixture roots, so a leaked `GIT_DIR` points them at the real repository. Exact test reproduced: the `emit-leaf — worktree layout end to end` teardown in pipeline-cli/src/cli/attestation.test.ts rmSync's join(git-common-dir, '..'); bisect of 87 git-spawning files: 1 deletes, 47 flip core.bare, 39 mutate, 0 clean.

Restored: fresh clone of origin moved into place (remnant kept at `ai-sdlc.deleted-remnant-2026-10-30`), 45 of ~90 `.claude/memory` notes rebuilt from session transcripts, MEMORY.md index rewritten from context. Lost for good: `.ai-sdlc/dispatch` board state (gitignored), untracked parent files (LAST_MESSAGE.md, `reference/.ai-sdlc/`), unpushed worktree commits (1123's local rebase+fixup, 785's re-signed chore commits), `node_modules`, and the memory notes not present in any transcript.

**Why:** the hierarchy must not be brought back up until the pre-push coverage gate is made safe; running it again from a worktree can repeat the wipe.

**How to apply:** fix is PR #2191 (hook unset, gitSafeEnv(), vitest.git-env.setup.mjs, tmpdir guard, incident record docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md; RCA doc https://claude.ai/artifact/KPKt8F2uJ1yU5vttrKC6p2). #2191 merged 2026-10-31 02:49Z and the hierarchy was restarted at 02:58Z on main 8b809420; follow-up tasks AISDLC-1127..1131 filed (#2192, #2193, #2195, #2194, 1130 re-filed); manual pushes meanwhile set `AI_SDLC_SKIP_PATCH_COVERAGE_GATE=1`; kill the orphaned tmux sessions (ai-sdlc-planner, ai-sdlc-operator-dispatch, ai-sdlc-executor-aisdlc-785, ai-sdlc-executor-aisdlc-1123) before restarting. Follow-up tasks to file are listed in the incident record. Related: [[feedback_overbuild_patch_coverage_locally]], [[feedback_worktree_node_version_and_hooks]].
