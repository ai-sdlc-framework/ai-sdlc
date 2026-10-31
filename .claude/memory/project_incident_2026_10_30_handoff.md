---
name: incident-2026-10-30-handoff
description: Handoff from the operator session that handled the 2026-10-30 repo deletion end to end; where everything stands at 2026-10-31 03:05Z and what the next session picks up
metadata:
  node_type: memory
  type: project
  originSessionId: 148b7e70-ff0c-4b4c-b070-b3c408f73012
  modified: 2026-10-31T03:22:26.358Z
---

**What happened (full RCA in `docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md` and the doc https://claude.ai/artifact/KPKt8F2uJ1yU5vttrKC6p2).** 23:57Z to 00:05Z the parent checkout and all 45 worktrees were deleted by the pipeline-cli test suite: the new pre-push patch-coverage gate (#2168) ran it from a linked worktree with git's exported `GIT_DIR`, and the `emit-leaf — worktree layout end to end` teardown in `pipeline-cli/src/cli/attestation.test.ts` rmSync'd `join(git-common-dir, '..')`. Reproduced in a sacrificial repo; bisect of 87 git-spawning test files: 1 deletes, 47 flip core.bare, 39 mutate, 0 clean. No Claude session ran a delete.

**Fixed and merged:** PR #2191 (AISDLC-1126, main 8b809420, 02:49Z): hook `unset GIT_DIR ...`, `gitSafeEnv()` in the gate script, `vitest.git-env.setup.mjs` first setup file, strict tmpdir guard, standing-rules renderer no longer prints decision ids (two gates had conflicted on main since #2190), patch-coverage exclusion for the new setup file, incident record + ledger row. Three reviewers approved three heads; attestation signed via `cli-attestation emit-leaf` per reviewer (hand-run reviewers: harness nonce null, `.active-task` sentinel needed, leaves rebind on every content change).

**Recovery state:** fresh clone in place (remnant at `../ai-sdlc.deleted-remnant-2026-10-30`, only empty skeletons, safe to delete). Lost for good: dispatch board, 61 of ~90 memory notes (45 rebuilt from transcripts; index intact), untracked parent files, unpushed commits of AISDLC-785 (remote ec52478e1) and AISDLC-1123 (#2180). Recreated: `LAST_MESSAGE.md`, `.claude/settings.local.json` (`crossSessionInbound: accept`), `git config core.fileMode false` to hide pnpm's chmod noise on `pipeline-cli/bin/*`.

**Hierarchy:** restarted 02:58Z on fixed main (planner fable, dispatch sonnet, scheduler, webhook 8765); orphaned sessions killed. Board empty.

**Follow-ups filed (docs PRs, awaiting CI + auto-merge, then brief and execute):** AISDLC-1127 #2192 git-env hygiene gate; AISDLC-1128 #2193 fixture teardown guard sweep; AISDLC-1129 #2195 doctor check + core.bare escalation; AISDLC-1130 #2196 board rebuild/backup; AISDLC-1131 #2194 memory backup. Filing lesson: no sibling task ids in task prose (DoR gate 7); run `cli-file` from a directory that will not be removed mid-run.

**Why:** the next session must know the fix is on main (hierarchy may run), the board is empty by loss not by design, and 785/1123 need reentry from remote heads.

**How to apply:** read `LAST_MESSAGE.md` first; verify main-health on 8b809420 is green; let #2192-#2196 land and brief 1127-1131; reenter 785 and 1123; delete the remnant dir when convenient. Related: [[repo-deletion-2026-10-30]], [[feedback_last_message_survives_auto_clear]].


## Incident write-up (moved from the root LAST_MESSAGE.md on 2026-10-31)

INCIDENT 2026-10-30 23:57Z-00:05Z: the parent checkout and all 45 worktrees were deleted on disk. No Claude session ran a delete (all transcripts checked). Sequence: 23:56:5x parent HEAD moved to the AISDLC-1123 branch and core.bare flipped to true; 23:56:58 the AISDLC-785 executor's `git push` ran the new pre-push patch-coverage gate (AISDLC-1119, #2168), which runs `pnpm --filter ./pipeline-cli test:coverage` inside a linked worktree with `GIT_DIR` exported by git and never unset by `.husky/pre-push`; 23:57:10 onward every entry under the repo root was removed in lexical order. 81 of 87 pipeline-cli tests that spawn git do not strip GIT_DIR; several toggle core.bare, check out branches and remove their fixture roots. Exact test identified and reproduced: the `emit-leaf — worktree layout end to end` teardown in pipeline-cli/src/cli/attestation.test.ts (rmSync of join(git-common-dir, '..')); per-file bisect of 87 git-spawning test files: 1 deletes, 47 flip core.bare, 39 mutate, 0 clean.

Restored: fresh clone of origin at the original path (remnant at ../ai-sdlc.deleted-remnant-2026-10-30), 45 of ~90 memory notes rebuilt from transcripts, MEMORY.md rewritten. Lost: dispatch board (gitignored), untracked parent files, unpushed worktree commits (1123 local rebase, 785 re-sign), 61 memory notes (index lines kept). Orphan tick/webhook killed; io hierarchy tick resumed; old tmux sessions (ai-sdlc-planner, ai-sdlc-operator-dispatch, executors 785/1123) still alive but pointing at the deleted tree.

Fix PR #2191 (fix/pre-push-unset-git-dir): hook unset, gitSafeEnv(), vitest.git-env.setup.mjs, tmpdir guard; incident record docs/operations/incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md; RCA doc https://claude.ai/artifact/KPKt8F2uJ1yU5vttrKC6p2. DO NOT run `cli-hierarchy up` or any executor push until #2191 is on main (manual pushes: AI_SDLC_SKIP_PATCH_COVERAGE_GATE=1); kill tmux ai-sdlc-planner, ai-sdlc-operator-dispatch, ai-sdlc-executor-aisdlc-785, ai-sdlc-executor-aisdlc-1123 before restart. Pre-existing red on main: prompt-rules.test.mjs standing-rules block out of sync (2 tests). pnpm install done in the restored clone.

STATE 03:00Z 10-31: PR #2191 MERGED at 02:49Z (main 8b809420): GIT_DIR hygiene fix + standing-rules renderer fix + AISDLC-1126 task + attestation. Parent fast-forwarded, reinstalled, rebuilt; fix worktree removed; orphaned tmux sessions killed; .claude/settings.local.json ({crossSessionInbound: accept}) recreated (was untracked, lost in the wipe). Hierarchy UP at 02:58Z: planner (fable), dispatch (sonnet), scheduler, webhook; board empty (0/0/0/0, the old board is gone). Follow-up filings: #2192 (1127), #2193 (1128), #2195 (1129), #2194 (1131) open docs PRs; 1130 re-filed from the parent (check `gh pr list --search AISDLC-1130`). Next for dispatch/planner: let the filing PRs land, brief 1127-1131, reenter AISDLC-785 (branch ec52478e1, non-ff push) and AISDLC-1123 (#2180) from their remote heads; main-health run on 8b809420 should be green (standing-rules fix) - verify. Remnant dir ../ai-sdlc.deleted-remnant-2026-10-30 holds only empty skeletons.

HANDOFF 03:05Z 10-31: this operator session's context is being cleared. Memory note .claude/memory/project_incident_2026_10_30_handoff.md holds the summary; this file holds the timeline. Nothing is mid-flight in this session: all pushes done, no open worktree of mine, background jobs finished. Pending elsewhere: filing PRs #2192-#2196 (CI + auto-merge), main-health run on 8b809420, dispatch reentry of AISDLC-785 and AISDLC-1123.
