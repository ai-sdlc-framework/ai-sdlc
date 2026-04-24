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

### Lifecycle rules

- **Create before execution.** When a plan includes multiple issues (e.g. an RFC implementation), create ALL backlog tasks BEFORE starting work on any of them. Use `mcp__backlog__task_create` with `milestone` + `labels` + acceptance criteria.
- **Claim on start.** Flip status to `In Progress` via `mcp__backlog__task_edit` the moment you begin coding a task. Don't stack multiple tasks in progress unless they're actually being worked in parallel.
- **Complete on merge.** When the PR lands (or the task is verifiably done), mark `Done` AND check every acceptance criterion via `acceptanceCriteriaCheck: [1, 2, ...]` AND write a `finalSummary` documenting changes, design decisions, verification evidence, and follow-up. No exceptions.
- **Never leave "To Do" after implementation.** If you finish work on AISDLC-N, AISDLC-N must be `Done` before you push. Retroactive close-out is acceptable, blank close-out is not.

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
