# AI-SDLC Project Instructions

## Git Flow

- **Always rebase** feature branches onto main. Never merge main into a feature branch.
- When updating a feature branch with latest main: `git fetch origin && git rebase origin/main`
- After rebase: `git push --force-with-lease origin <branch>`
- Never use `gh api pulls/N/update-branch` with merge method.
- Keep commit history linear — no merge commits on feature branches.

## Branch Naming

- Feature branches: `feat/<description>` or `ai-sdlc/issue-<number>`
- Fix branches: `fix/<description>`

## Commits

- Use conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` on all commits

## PRs

- **Never merge PRs** — only humans merge.
- **Never close issues or PRs.**
- **Never force push to main/master.**
- Dismiss stale reviews with a documented reason when they are false positives (truncated JSON, API errors).

## Testing

- Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before pushing.
- Hook scripts (`.js` in `ai-sdlc-plugin/hooks/`) are tested via Node built-in test runner (`.test.mjs`), not Vitest.
- MCP server and orchestrator use Vitest.

## Code Style

- TypeScript strict mode, ESM modules.
- Prettier for formatting, ESLint for linting.
- No unnecessary abstractions — three similar lines are better than a premature abstraction.

## Backlog Workflow

Backlog tasks live in `backlog/tasks/` (Backlog.md) and are managed via the `mcp__backlog__*` MCP tools. Every issue executed under the AI-SDLC pipeline MUST be tracked here.

### Canonical execution paths

| Use case | Command | Billing | Notes |
|---|---|---|---|
| **Internal dogfood (backlog tasks)** | `/ai-sdlc execute <task-id>` (slash command) | Subscription (Claude Code Max) | Runs as Claude Code subagents. Worktree-isolated. Auto-creates sibling-repo PRs from `permittedExternalPaths`. Marks Done + moves file in the same PR. |
| **Manual ad-hoc cleanup** | `/ai-sdlc cleanup [<task-id>]` | n/a | Sweeps merged worktrees from `.worktrees/` (no args) or force-removes one (with task-id). Never deletes branches automatically. |
| **GitHub-issue / unattended / CI** | `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | API key | Orchestrator-driven (TypeScript service). Use this when a Claude Code session isn't available — webhooks, cron, contributor-PR workflow. |

For any internal task, default to `/ai-sdlc execute`. The orchestrator-driven path is reserved for unattended/programmatic use.

### Done semantics — `/ai-sdlc execute` vs other paths

- **`/ai-sdlc execute` path**: Done = "reviews-approved-and-PR-opened". The command marks Done + runs `task_complete` (moving the file to `backlog/completed/`) BEFORE pushing the PR, so the entire task lifecycle lands atomically in one PR. No follow-up workflow needed.
- **Other paths (orchestrator, manual, external contributors)**: Done = "merged". The `.github/workflows/backlog-task-complete.yml` workflow opens a follow-up PR after merge to flip status and move the file. The workflow is idempotent — when the file is already in `backlog/completed/` (because `/ai-sdlc execute` already moved it), the workflow short-circuits to a no-op.

### Cross-repo writes — `permittedExternalPaths`

Tasks that legitimately need to write into sibling git repos (e.g. AISDLC-68 writing into `../ai-sdlc-io/`) declare an allowlist in their frontmatter:

```yaml
---
id: AISDLC-68
title: ...
permittedExternalPaths:
  - '../ai-sdlc-io/'
---
```

The PreToolUse hook reads this when `AI_SDLC_ACTIVE_TASK_ID` is set (which `/ai-sdlc execute` exports automatically). Without the allowlist, writes outside the worktree are denied. With the allowlist, the developer subagent may write to the listed paths but does NOT commit there itself — `/ai-sdlc execute` Step 12 creates parallel PRs in the sibling repos.

### Lifecycle rules

- **Create before execution.** When a plan includes multiple issues (e.g. an RFC implementation), create ALL backlog tasks BEFORE starting work on any of them. Use `mcp__backlog__task_create` with `milestone` + `labels` + acceptance criteria.
- **Claim on start.** Flip status to `In Progress` via `mcp__backlog__task_edit` the moment you begin coding a task. (Handled automatically by `/ai-sdlc execute`.) Don't stack multiple tasks in progress unless they're actually being worked in parallel.
- **Complete — two steps, both required:**
  1. `mcp__backlog__task_edit` with `status: 'Done'`, `acceptanceCriteriaCheck: [1, 2, ...]`, and `finalSummary` documenting changes / design decisions / verification / follow-up.
  2. `mcp__backlog__task_complete` to **physically move the file from `backlog/tasks/` to `backlog/completed/`**. `task_edit` alone only flips the status field — the file stays in `tasks/` until `task_complete` archives it. A task isn't actually closed in the repo until it's in `backlog/completed/`.

  When using `/ai-sdlc execute`, both steps run automatically after reviews approve. When using other paths, run them yourself OR rely on the `backlog-task-complete.yml` post-merge workflow.
- **Never leave "To Do" after implementation.** If you finish work on AISDLC-N, AISDLC-N must be in `backlog/completed/` before (or atomically with) the PR merge. Retroactive close-out is acceptable, blank close-out is not.

### `finalSummary` template

```markdown
## Summary
<one-paragraph description of what shipped>

## Changes
- `path/to/file.ts` (new|modified): <what changed and why>
- ...

## Design decisions
- **<Decision>**: <reason>. <tradeoff or context>.
- ...

## Verification
- `pnpm build` — clean
- `pnpm vitest run <test-file>` — N/N pass
- `pnpm test` (full workspace) — <counts>, no regressions
- `pnpm lint` — clean

## Follow-up
<what unblocks next, what to do in a future PR, or "closes milestone M-N">
```

### When NOT to create a backlog task

- Inline fixes caught during review (use the PR itself).
- Trivial chores — dependency bumps, config tweaks, typo fixes.
- Exploration / spikes — if it becomes real work, retroactively create a task.

### Status-value conventions

- Backlog task statuses: `Draft`, `To Do`, `In Progress`, `Done`. Use `Draft` for tasks that aren't ready to execute (missing AC, blocked on decisions) and `To Do` for ready work.
- Task IDs: `AISDLC-<N>` is the standard prefix for project work. Sub-project task IDs (e.g. external contrib) follow their own conventions.

### Verification before closing

Run the full workspace test suite and lint BEFORE flipping to `Done`:

```bash
pnpm build && pnpm test && pnpm lint
```

Cite the counts in `finalSummary`. If you can't reproduce the counts in the task description, the task isn't done.

### Close-out checklist (end of task)

```
□ mcp__backlog__task_edit     → status: Done, acceptanceCriteriaCheck, finalSummary
□ mcp__backlog__task_complete  → moves file from tasks/ → completed/
□ verify with mcp__backlog__task_list (status: Done) that the task appears in the Done list
```

The file location is the source of truth: `backlog/tasks/<id>-*.md` = open, `backlog/completed/<id>-*.md` = closed. `task_edit` sets the status field inside the file but does NOT move it; `task_complete` does both.
