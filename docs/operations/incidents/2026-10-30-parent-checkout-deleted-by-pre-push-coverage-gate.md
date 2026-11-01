# Parent checkout and all worktrees deleted by the pre-push coverage gate

## What happened

On 2026-10-30 between 23:57Z and 00:05Z the whole operator checkout at `Documents/dev/ai-sdlc/ai-sdlc` was deleted from disk: the shared `.git`, every tracked and untracked file, and all 45 task worktrees under `.worktrees/`. The deletion was done by the pipeline-cli test suite, launched by the new pre-push patch-coverage gate (AISDLC-1119, landed as #2168 at 23:49Z the same day) during an executor's `git push` from a linked worktree. Git exports `GIT_DIR` to pre-push hooks, the hook never unset it, and the tests inherited a `GIT_DIR` that named the real repository.

No Claude session issued a delete command. All eleven transcripts active that evening (planner, dispatch, operator session, eight executors) and the sibling ai-sdlc-io hierarchy's tick log were checked.

## Impact

- Lost for good: the dispatch board under `.ai-sdlc/dispatch` (gitignored: 446 done, 30 failed verdicts, briefs, manifests), untracked parent files (`LAST_MESSAGE.md`, `reference/.ai-sdlc/`), every `node_modules`, and 61 of about 90 untracked `.claude/memory` notes (45 were rebuilt from session transcripts; the index survived in a session's context).
- Lost unpushed work: the AISDLC-1123 executor's local rebase and fixup commit, and the AISDLC-785 executor's re-signed attestation chore commits. Both remote branches still exist at their earlier heads.
- Every roster session (planner, dispatch, two executors) kept running against a directory that no longer existed; the webhook and scheduler orphaned.
- Nothing on GitHub was affected. `main` and every pushed branch were intact and the checkout was restored by cloning origin.

## Timeline (UTC)

- 23:49 PR #2168 lands: `.husky/pre-push` now runs `scripts/pre-push-patch-coverage.mjs`, which runs `pnpm --filter ./<pkg> test:coverage` for each touched package.
- 23:55:55 Executor for AISDLC-785 resumes its task: `next-step` in `.worktrees/aisdlc-785`, review skipped (patch id unchanged), Step 10.5 drops two attestation chore commits, Step 11 starts `git push -u origin ai-sdlc/aisdlc-785-...`.
- 23:56:45 `git push` runs `.husky/pre-push` with `GIT_DIR=<parent>/.git/worktrees/aisdlc-785` and `GIT_PREFIX=` exported by git (confirmed by experiment, see Root cause).
- 23:56:58 The coverage gate starts `vitest run --coverage` for pipeline-cli (567 files, 12,400 tests) with that environment.
- 23:56:5x to 23:57:02 Fixture tests run `git init --bare` and `git checkout` against the leaked `GIT_DIR`: the real `.git/config` gets `core.bare=true` and the parent HEAD moves off `main`. The AISDLC-1123 executor's `next-step` is refused at Step 0 at 23:56:56 ("parent is on 'ai-sdlc/aisdlc-1123-...', not main") and 23:57:00 ("parent has tracked changes"); at 23:57:02 `git status` in the parent fails with "this operation must be run in a work tree" and `git rev-parse --is-bare-repository` prints `true`. At 23:57:07 `ls -a` still lists `.git`, `.github`, `.husky` and the rest.
- 23:57:10 to 23:57:55 A test teardown resolves `git rev-parse --git-common-dir` from its fixture worktree, gets the real `<parent>/.git`, and runs `rmSync(join(common, '..'), { recursive: true, force: true })`. Entries disappear in directory order: dot-entries first, then `.worktrees/` (45 trees with `node_modules`), then the visible tree.
- 23:57:55 The coverage run fails; the AISDLC-785 pipeline aborts at Step 11 with `push-non-fast-forward`. The deletion continues in the background.
- 23:57:57 The scheduler tick refuses: "the main checkout could not be verified". The webhook recreates an empty `.ai-sdlc/dispatch/` skeleton.
- 00:05 Deletion completes. Only `.ai-sdlc/dispatch/` (empty), a freshly created `.claude/memory/` and a stub `.worktrees/aisdlc-785/pipeline-cli/node_modules/.vite` remain.
- 00:12 to 00:20 The planner (asked by the operator to survey transcript retention) and the operator session independently notice the missing `.git`; both read only.
- 00:30 to 00:50 Recovery: the two `cli-dispatch reconcile --watch` processes are paused and inspected (the ai-sdlc-io one was innocent and resumed; the parent's was killed with its webhook), origin is cloned next to the remnant, the clone is moved into place and the remnant kept as `ai-sdlc.deleted-remnant-2026-10-30`, memory notes are rebuilt from transcript `Write`/`Read` records, `pnpm install` run.
- 01:15 to 01:35 Reproduction in a sacrificial repository (below) and the fix.

## Ruling and who made it

Operator, 2026-10-30 (chat): "fix the pre-push hook to unset GIT_DIR" and "I want a full root cause report". No decision record yet; the fix is a tightening (class (a)).

Standing rule from this incident: the hierarchy is not brought up, and no executor pushes, until the fix PR is on `main`. Until then any manual push sets `AI_SDLC_SKIP_PATCH_COVERAGE_GATE=1`.

## Root cause

Three conditions combined. Each is confirmed by experiment in a throwaway repository, not inferred.

1. **Git exports repository variables to hooks run from a linked worktree.** When the worktree's `.git` is a gitfile, git calls `set_git_dir()` with export, so every hook child sees `GIT_DIR=<absolute path to parent/.git/worktrees/<name>>` and `GIT_PREFIX`. Verified: a pre-push hook that prints `env | grep ^GIT_` from a linked worktree shows exactly that.
2. **The pre-push hook forwards its environment unchanged.** `.husky/pre-push` had no `unset GIT_DIR`; `scripts/pre-push-patch-coverage.mjs` spawned `pnpm` and `node` with `process.env`; `vitest.shared.mjs` had no setup that strips the variables. The existing helper `pipeline-cli/src/__test-helpers/git-env.ts` documents this exact leak and strips the variables, but only 6 of the 87 pipeline-cli test files that shell out to git use it.
3. **Tests trust git to tell them where their fixture is.** With `GIT_DIR` set, `git init --bare <tmp>` re-initialises the real repository as bare (so `core.bare=true` lands in the shared config), `git checkout -b` moves the real HEAD, and `git rev-parse --git-common-dir` answers with the real `.git`. The teardown of `emit-leaf — worktree layout end to end` in `pipeline-cli/src/cli/attestation.test.ts` computes `mainRoot = join(common, '..')` from that answer and deletes it recursively.

Reproduction: a victim repository with one linked worktree, `GIT_DIR` pointed at its worktree gitdir, and `vitest run` of the pipeline-cli suite from an unrelated checkout. The full suite deleted the victim's main directory and left only its worktree, matching the production remnant. Per-file runs (one fresh victim per test file, pre-fix vitest config) then classified all 87 git-spawning pipeline-cli test files:

| Outcome for the repository named by the leaked `GIT_DIR` | Files |
|---|---|
| Deleted outright (`pipeline-cli/src/cli/attestation.test.ts`, teardown above) | 1 |
| `core.bare` flipped to true (fixture `git init --bare` / `git init` with `GIT_DIR` set) | 47 |
| Otherwise mutated (extra commits, refs, worktree entries or a dirty tree) | 39 |
| Clean | 0 |

The HEAD move to the AISDLC-1123 branch was not reproduced by any single file; it is consistent with the AISDLC-1123 executor's own shell, whose cwd fell back to the parent after a failed command at 23:56:43, running `git add`, `git commit -qam` and `git rebase --autosquash` there at 23:56:47 and 23:56:51 while the bare flip was in progress.

Why it surfaced now: before #2168 the pre-push hook ran only static checks and the fixups orchestrator, none of which spawn the test suite. The first executor push after the gate landed, from a linked worktree, was enough. The parent's `core.bare` flipping "from time to time" (AISDLC-137, auto-corrected by `check-orchestrator-state.sh`) was the same leak at smaller scale through other hook-spawned git calls, and was treated as a nuisance instead of a signal.

Why nothing stopped it: `rmSync(..., { force: true })` has no guard; the fixture-root check that would have refused a path outside `tmpdir()` did not exist; the parent checkout's "read-only" rule is enforced on agents' tool calls, not on child processes of a hook; and the tick's parent-upkeep repairs the bare flag only after the fact.

## Follow-up

Fix PR (this change), three independent layers plus a guard, each verified against the sacrificial repository:

- `.husky/pre-push` unsets `GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES` before the first gate (`scripts/pre-push-patch-coverage.test.mjs` asserts the line and its position).
- `scripts/pre-push-patch-coverage.mjs` spawns `pnpm` and the gate with `gitSafeEnv()` (tested).
- `vitest.git-env.setup.mjs`, registered first in `vitest.shared.mjs`, deletes the variables in every vitest worker for every package (pipeline-cli, orchestrator, mcp-server).
- The `attestation.test.ts` teardown refuses a fixture root outside the realpath of `tmpdir()`.

Verification of the fix: the full pipeline-cli suite re-run with `GIT_DIR` leaked at a fresh victim repository passes (567 files, 12,454 tests) and leaves the victim untouched: not bare, HEAD on `main`, clean tree, one commit, two worktrees. Before the fix the same run deleted the victim and failed 612 tests.

Still to do (file as tasks):

- Make `makeGitEnv()` (or the setup file) mandatory: a lint or dark-code style check that fails any test spawning `git` without it.
- A doctor check that reports `GIT_DIR` set in a hook's environment, and a `check-orchestrator-state.sh` change that treats a `core.bare` flip as an incident signal, not a self-heal.
- Teardowns that delete a path derived from a git answer must assert the path is under `tmpdir()` (sweep the 10 files that use `rmSync` on a git-derived root).
- ~~Board recovery runbook: rebuild `.ai-sdlc/dispatch` from GitHub PR state after a loss; the board was gitignored and had no backup.~~ Done: [board-recovery.md](../board-recovery.md) (AISDLC-1130).
- ~~Memory folder: decide whether `.claude/memory` is tracked or backed up; 61 notes were lost.~~ Resolved: durable notes are committed (PR #2212); regenerated state and `.mcp.json` are ignored (AISDLC-1136).
- Hierarchy restart after the fix lands: kill the orphaned tmux sessions (`ai-sdlc-planner`, `ai-sdlc-operator-dispatch`, `ai-sdlc-executor-aisdlc-785`, `ai-sdlc-executor-aisdlc-1123`) first.
