# Release mechanics, publish config and plugin MCP / Pattern C routing

Reference material moved out of `CLAUDE.md` by AISDLC-651.2 to keep the per-turn fixed prefix small. The rules themselves stay in `CLAUDE.md`; this runbook holds the mechanics, incident history and tables.

## Releases

**CHANGELOG.md is managed exclusively by release-please. Contributors MUST NOT edit it manually.**

### release-please rolling PR model (AISDLC-401)

`release.yml` fires on every push to `main`, runs `googleapis/release-please-action@v4`, and
maintains a **single rolling PR** (`chore: release main` on branch `release-please--branches--main`).
The rolling PR accumulates version bumps + CHANGELOG entries from conventional-commit messages.
Regular feature PRs MUST NOT touch CHANGELOG.md — parallel-merge conflicts are the penalty
(root cause of AISDLC-401, made visible after AISDLC-400 dropped the merge queue).

If a feature branch touches CHANGELOG.md, revert those changes (release-please reconstructs
them from your commit messages; AISDLC-838 deleted the warn-only pre-push hook). See [`docs/operations/release-flow.md`](./release-flow.md) for the full flow.

**Landing the release PR.** The governance hook refuses raw `gh` merge commands (including `--auto` arming). When the operator explicitly instructs a release, arm the release-please PR with `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm` (drop `--arm` to merge now). The CLI verifies the PR from GitHub (release branch, same repo, base `main`, release-only files whose content changes only version values, effective release author set (`governance.releaseAuthors`, else `mergeAuthors`, else the release-please bots; an explicit empty `releaseAuthors` disables the release path), green checks and CLEAN), squash-merges, and audits the call; the caller-role restriction (set `AI_SDLC_CALLER_ROLE=operator` from a plain shell) is a CLI role mistake guard (DEC-0038), not a security boundary; no hook-level control exists yet and a follow-up task adds one. When the release PR is authored by a shared PAT identity that agents also push as (this repo's setup), the author check is NOT the control; the controls are the exact release branch, content-based file validation and green checks. Release merges also need `governance.allowMerge: onGreenClean` or `governance.allowReleaseMerge: true` on main (a narrower grant for release PRs only; `allowMerge: never` does NOT stop release merges while `allowReleaseMerge: true`, so to stop all agent merges also leave `allowReleaseMerge` unset/false or set `releaseAuthors: []`; neither key affects GitHub's own auto-merge once armed). Never cut a release without an explicit operator instruction.

### Package configuration

`.github/workflows/release.yml` runs `pnpm -r publish --no-git-checks` with no `--access` flag. Every non-`"private": true` workspace package MUST carry:

```jsonc
"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
```

Without it, npm rejects with E402 silently per-package while the overall job appears green. `pnpm lint:publishable` (wired into `pnpm test`) catches regressions.

When adding a new publishable package: add to `pnpm-workspace.yaml`, add the `publishConfig` block (or mark `"private": true`), add to `release-please-config.json` if release-please should track its version. release-please does NOT add `publishConfig` automatically.

## Plugin MCP server — project root resolution (AISDLC-99, AISDLC-216)

The plugin's MCP server (`mcp__plugin_ai-sdlc_ai-sdlc__*` tools) resolves the project directory in this order: `AI_SDLC_PROJECT_ROOT` env → `CLAUDE_PROJECT_DIR` env → walk up from `process.cwd()` for an ancestor with `backlog/` → throw. Almost always falls through to the cwd-walk and finds the right project. Override with `AI_SDLC_PROJECT_ROOT=/abs/path` before launching Claude Code.

### Pattern C routing (AISDLC-216)

In Pattern C (non-bare parent repo + `.worktrees/<task-id>/` isolates), the parent's working tree is **read-only**. The MCP server starts from the parent's cwd and `process.cwd()` resolves to the parent root — without extra routing, writes would accumulate as untracked debris in the parent rather than landing in the correct worktree.

After resolving the candidate root, the resolver checks for Pattern C: if `<root>/.worktrees/` exists and contains at least one subdirectory, the root is a Pattern C parent and the following routing applies:

1. **`AI_SDLC_ACTIVE_TASK_ID` env var** — if set, routes to `<parent>/.worktrees/<task-id-lower>/`
2. **Per-worktree `.active-task` sentinels** — scans `<parent>/.worktrees/<id>/.active-task` (matches `pipeline-cli/src/steps/04-flip-status.ts` write location and `findWorktreeSentinel` pattern). When multiple worktrees have sentinels (parallel runs), the most-recently-modified one wins.
3. **No signal → refuse** with the Pattern C error message.

The typical Pattern C setup: `/ai-sdlc execute <task-id>` automatically writes `.worktrees/<task-id>/.active-task` (per AISDLC-81). For sessions where the env-var path is preferred (e.g. operator manually launching Claude Code into a multi-worktree project), set `AI_SDLC_ACTIVE_TASK_ID=AISDLC-NNN` before launch.

### Pattern C hard guards (AISDLC-358)

The parent working tree MUST be on `main` at all times. This is enforced by `scripts/check-orchestrator-state.sh` (called at Step 0 of every `/ai-sdlc execute` and by `cli-hierarchy tick`).

Guard logic (two outcomes):

- **Parent on non-main branch, clean working tree** → auto-recover: `git checkout main && git reset --hard origin/main`. Logs `[orchestrator-state] auto-recovered parent from '<branch>' to main`.
- **Parent on non-main branch, dirty working tree** → REFUSE. Prints the offending branch name, the dirty paths, and the manual recovery command. Exits non-zero (`check-orchestrator-state.sh`) The tick is aborted; no frontier work proceeds.

Recovery (operator): stash or commit your changes in the parent, then run `git checkout main && git reset --hard origin/main`.

**Sanctioned vs. ad-hoc reset (AISDLC-450):** `git reset --hard origin/main` is ONLY permitted when invoked by `scripts/check-orchestrator-state.sh` on a verifiably clean working tree. Ad-hoc `git reset --hard` by the Conductor or a subagent (outside the script) is forbidden — if the script refuses (dirty parent), escalate to the Decision Catalog (see `cli-hierarchy tick`).


**Decision events never land in the parent (AISDLC-874):** `cli-decisions add`, `answer` and `escalate` write to the linked worktree they run in, or to `.worktrees/<task-id>/` when run from the Pattern-C parent with `AI_SDLC_ACTIVE_TASK_ID` set. From the parent with no active task they refuse (nothing is written) and name the next step: run from the task worktree or set the active task. Reads still use the main checkout (AISDLC-825).

**Parent ff cleanup (AISDLC-874):** before the sync, `check-orchestrator-state.sh` deletes an untracked file whose path `origin/main` now tracks only when it is byte-identical to the `origin/main` copy (logged as `removed untracked <path>`). An untracked file that differs is never deleted: the script reports it and skips the reset. Step 0.5 (`00-5-sync-parent.ts`) applies the same rule to untracked `.ai-sdlc/_decisions/events/` files. Only untracked files are removed; tracked or modified files are never touched and no new hard reset is introduced.

## Shipped plugin skills (AISDLC-944)

`ai-sdlc-plugin/skills/` ships three skills: `ai-sdlc-governance` (governance rules, loaded at session start), `decision-rubric` (the rubric for non-trivial operator questions) and `rfc-oq-walkthrough` (the eight-phase RFC open-question lifecycle, composing with `decision-rubric`). `ai-sdlc-plugin/skills/skills.test.mjs` validates every skill (frontmatter, name equals directory, description cap, `[[skill]]` references resolve) and runs inside `test:plugin-suite-gate`.
