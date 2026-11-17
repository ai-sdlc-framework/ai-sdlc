---
id: AISDLC-1282
title: '`ai-sdlc init` next steps: the printed `git add` works in the repository, and a skipped branch protection is reported as skipped'
status: Done
assignee: []
created_date: '2026-11-16'
labels:
  - orchestrator
  - adopter
  - bug
dependencies: []
references:
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - docs/operations/init.md
  - docs/getting-started/install-agent-brief.md
priority: low
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2680). Verified by the planner in source at main 1ffab4a1: step 1 of `renderNextSteps` is the fixed string `git add .ai-sdlc .github/workflows package.json`, and the last `else` of the branch-protection step prints "(dry-run) — see JSON above" whenever `result.branchProtection` is unset. The operator ordered the filing on 2026-11-16.'
---

## Description

**Gap (issue #2680).** Two lines of the "Next steps" text printed by `ai-sdlc init` do not match what the run did.

1. Step 1 always prints `git add .ai-sdlc .github/workflows package.json` (`orchestrator/src/cli/commands/init-features.ts`, about line 2002). In a repository with no `package.json` that command exits 128 (`pathspec 'package.json' did not match any files`) and stages nothing. It also leaves out `.husky`, `CLAUDE.md` and `.gitignore`, which the same run may have created or changed. `docs/operations/init.md` (about line 119) gives a different fixed list, `git add .ai-sdlc .github .husky CLAUDE.md`, which fails when init wrote the hook to `.git/hooks/pre-push` and no `.husky` folder exists.
2. With `--no-branch-protection`, the run logs the skip and leaves `result.branchProtection` unset (about lines 1825-1829). `renderNextSteps` then falls to its last `else` (about lines 2092-2095) and prints "Branch protection (dry-run) — see JSON above". No dry-run happened and no JSON was printed. Non-TTY stdin without `--yes`, and `--add branch-protection --no-branch-protection`, print the same line.

**Shape.** The printed `git add` lists only paths that exist. A branch-protection step that was skipped says so. A real dry-run keeps its text.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a printed `git add` needed? Yes: it is the adopter's first action after init. 2. Deleted: the fixed path list. 3. Simplified or optimised: one ordered candidate list (`.ai-sdlc`, `.github/workflows`, `.husky`, `CLAUDE.md`, `.gitignore`, `package.json`), filtered by existence in the project directory. 4. Accelerated: n/a. 5. Automated: tests for the printed text in each state.

- Step 1 builds the `git add` arguments from the candidate list above, keeping only paths that exist in the project directory when the text is rendered.
- The branch-protection step distinguishes three states: a result exists (applied, client-side or error: unchanged text); a real dry-run (a result is returned for it, text unchanged); the feature was selected and no result exists (skipped). For the skipped state it prints that branch protection was skipped and how to apply it later (`ai-sdlc init --add branch-protection`), with no "dry-run" and no "see JSON above".
- `docs/operations/init.md`: replace the fixed `git add` list with a sentence that says to run the command init prints, and why the list varies.

## Acceptance Criteria

- [ ] #1 After `ai-sdlc init --yes --no-branch-protection` in a repository with no `package.json`, the `git add` command printed under "Next steps" names no missing path; a test asserts every printed path exists.
- [ ] #2 The same holds in a repository whose `package.json` does not declare husky (no `.husky` in the printed command when the folder does not exist).
- [ ] #3 After `ai-sdlc init --yes --no-branch-protection`, the "Next steps" output does not contain "dry-run" or "see JSON above", and says branch protection was skipped.
- [ ] #4 After `ai-sdlc init --yes --dry-run`, the "Next steps" output still contains the branch-protection dry-run step.
- [ ] #5 `docs/operations/init.md` no longer prints a fixed `git add` path list that can fail.
- [ ] #6 The PR body carries `Closes #2680`.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
