---
name: ai-sdlc-governance
description: AI-SDLC project governance rules, workflow expectations, and pre-commit checklist. Loaded automatically at session start.
autoContext: true
---

# AI-SDLC Governance Rules

## Critical Rules — NEVER violate these

1. **NEVER merge any pull request.** Do not run `gh pr merge`, `git merge` into main, or any merge operation. Only create or update PRs. The human merges.
2. **Dismiss PR reviews only with documented reason.** You may dismiss reviews when they failed due to infrastructure issues (e.g., API credit exhaustion) or when findings are documented false positives. Always include a clear explanation in the dismissal message. Prefer updating `.ai-sdlc/review-policy.md` for recurring false positives.
3. **NEVER close issues or PRs.** Do not run `gh pr close` or `gh issue close`. The human decides what to close.
4. **NEVER force push.** Do not run `git push --force` or `git push -f`.
5. **NEVER delete branches.** Do not run `git branch -D` or `git branch -d`.
6. **NEVER run destructive git operations.** No `git reset --hard`, `git checkout -- .`, `git restore .`.

These rules are also enforced technically via `.claude/hooks/enforce-blocked-actions.sh` and `.ai-sdlc/agent-role.yaml` `blockedActions`.

## Pre-Commit Checklist

Before EVERY commit, run these checks and fix any failures:

```bash
pnpm build          # TypeScript compilation — catches type errors
pnpm test           # All tests must pass
pnpm test:coverage  # Coverage thresholds enforced (80% lines/functions/statements, 70% branches)
pnpm lint           # ESLint — no errors allowed
pnpm format:check   # Prettier — run `pnpm format` to fix
```

### Test File Check
Before committing new `.ts` modules, verify:
- Every new `src/**/*.ts` file (not `types.ts`, `index.ts`) has tests somewhere
- Tests can be in a co-located `.test.ts` file OR in another test file that imports it
- Run the relevant tests and confirm they pass before staging

Do NOT rely on CI to catch missing tests — check locally first.

Do NOT commit if any of these fail. Fix the errors first, then commit.

## Git Flow

- **Always rebase** feature branches onto main. Never merge main into a feature branch.
- When updating a feature branch with latest main: `git fetch origin && git rebase origin/main`
- After rebase with conflicts resolved: `git push --force-with-lease origin <branch>`
- Never use `gh api pulls/N/update-branch` with merge method.
- Keep commit history linear — no merge commits on feature branches.
- Use conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `style:`

## Workflow Expectations

When given a multi-step task, complete ALL steps before stopping:

1. Research the task by reading relevant files
2. Plan the approach (use EnterPlanMode for non-trivial tasks)
3. Implement the changes
4. Run typecheck, tests, lint, format — fix any failures
5. Commit with a conventional commit message
6. Push to the branch
7. Create a PR if needed (but do NOT merge)
8. Report what was done and what remains

If blocked at any step, say which step you're stuck on and why.

## PR Workflow

- Create PRs with descriptive titles and bodies
- After pushing, tell the user the PR is ready for their review
- If CI fails or reviews request changes, fix the issues and push again
- Use `/fix-pr <number>` to automatically gather and fix PR issues
- NEVER merge — always wait for the human

## Review Policy

When review agents post findings:
- **APPROVE with suggestions/minors** → PR is ready for human merge
- **CHANGES_REQUESTED with critical/major** → fix the real issues, push again
- **False positives** → update `.ai-sdlc/review-policy.md` with better calibration, don't dismiss reviews

## Project Structure

- `orchestrator/` — core pipeline logic (TypeScript)
- `reference/` — framework reference implementation
- `dogfood/` — CLI scripts that invoke the orchestrator
- `.ai-sdlc/` — pipeline configuration (YAML) — agents cannot modify these files
- `.claude/` — Claude Code hooks, commands, and skills
- `.github/workflows/` — GitHub Actions — agents cannot modify these files
- `spec/schemas/` — JSON schemas for YAML validation

## Testing

- Use Vitest for all orchestrator and reference tests
- Coverage target: 80% patch coverage on PRs
- Run `pnpm test` from repo root for all packages
- Run `pnpm --filter @ai-sdlc/orchestrator test` for orchestrator only
