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
