---
paths:
  - "backlog/**"
  - ".github/workflows/**"
  - ".worktrees/**"
  - "ai-sdlc-plugin/agents/**"
  - "ai-sdlc-plugin/commands/**"
---

# Git, CI, backlog and subagent detail

Moved from `CLAUDE.md` (AISDLC-1152); the short forms stay there.

## Git and merging

- Modes (DEC-0264): `lease` (this repo) = any non-protected branch, any session; `leaseOnOwnBranch` (adopter default, AISDLC-710) = the task's own worktree only; `never` = no lease push. `main`/`master`/protected stay refused. Never force-push `main`/`master`.
- CHANGELOG.md is owned by release-please: never edit it on a feature branch; remove such a diff on rebase conflict (AISDLC-401).
- **Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command.** The release-please PR lands only via `cli-merge-if-eligible --source-kind release` on explicit operator instruction (see Releases).

## CI

- One CI run per PR (AISDLC-727): only `ai-sdlc-gate.yml` runs CI on `pull_request`; open PRs are rebased only on conflict.
- Workflows MUST call pipeline-cli via `node pipeline-cli/bin/cli-XXX.mjs`, never `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX` (workspace own-bins do not resolve; AISDLC-156).

## Subagents

- A review/audit/read-only task that surfaces follow-up work presents the recommendation and STOPS until the operator authorizes filing tasks, extra PRs or subagent dispatch. "Pre-work required", "Pre-conditions" or "OQ walkthrough needed" prose is a HARD precondition.
- **OQ resolution prohibition (AISDLC-298):** dev subagents MUST NOT resolve RFC Open Questions inline: no `**Resolution:**` / `RESOLVED:` / `✅ RESOLVED` marker, no replacing an OQ with a design decision, no code that implicitly resolves one.
- **Model defaults:** every agent and command pins `model:` (never `inherit`; `pnpm test:plugin-model-pins-gate`). Route code/test review to `-codex` variants on dispatch paths; never wrap mechanical work (sign, reconcile, rebase) in subagents.
- **Prompt rules live in one source (AISDLC-651.2):** "never do X" rules are defined once in `ai-sdlc-plugin/hooks/lib/prompt-rules.js` and rendered as one line per agent/command; do not restate them in prose ([`docs/operations/prompt-rules.md`](docs/operations/prompt-rules.md)).

- **Resumed developer round is commit-only (AISDLC-1227):** the PR already exists, so the developer neither rebases nor pushes and returns the existing PR URL; Step 11 stays the sole pusher of a ready PR (RFC-0061 OQ-2), and the PreToolUse guard denies a push while `resume.developerRound` is set.

## Backlog

- Filenames must be ASCII.
- **`dispatchable: false`** (AISDLC-243) in frontmatter keeps the orchestrator from dispatching permanent human-only work (soak phases, investigations); default is dispatchable.
- The dev subagent writes; it never commits in the sibling repo.

## Pattern C

In Pattern C (non-bare parent + `.worktrees/<task-id>/`) the parent working tree is **read-only**; MCP writes route to the worktree named by `AI_SDLC_ACTIVE_TASK_ID` or a per-worktree `.active-task` sentinel, else refuse. The parent MUST stay on `main` (AISDLC-358): `scripts/check-orchestrator-state.sh` auto-recovers a clean parent and aborts the tick on a dirty one. `git reset --hard origin/main` is permitted only inside that script on a clean tree; if it refuses, escalate to the Decision Catalog.
