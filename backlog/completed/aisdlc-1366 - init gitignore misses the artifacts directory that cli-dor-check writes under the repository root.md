---
id: AISDLC-1366
title: 'Init gitignore misses the artifacts directory that cli-dor-check writes under the repository root'
status: Done
assignee: []
created_date: '2026-11-21'
labels:
  - bug
  - orchestrator
  - adopter
dependencies: []
references:
  - orchestrator/src/runtime-gitignore.ts
  - orchestrator/src/runtime-gitignore.test.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - orchestrator/src/cli/commands/init-workspace.test.ts
  - pipeline-cli/src/dor/calibration-log.ts
  - pipeline-cli/src/judgment/context.ts
  - pipeline-cli/src/steps/00-5-sync-parent.ts
priority: high
---

## Description

**Gap.** In a fresh adopter repository, one `cli-dor-check --task` run writes files under `<repo>/artifacts/` that init's `.gitignore` block does not cover. They show as untracked, and Step 0.5 then refuses `/ai-sdlc:execute`. Reference: https://github.com/ai-sdlc-framework/ai-sdlc/issues/2743.

What was observed (from the issue, not reproduced here). On main at 04a91ceb, in a new repository after `ai-sdlc init --yes --skip-mcp --no-branch-protection` and one committed task file, `ARTIFACTS_DIR` unset, `cli-dor-check --task <file>` exited 0 and `git status --porcelain` listed `.ai-sdlc/context-index.db` and `artifacts/`. Calling `syncParentUntrackedFiles` returned `ok: false`, naming `.ai-sdlc/context-index.db`, `artifacts/_capabilities/state.json` and `artifacts/_dor/calibration.jsonl`.

**Already fixed on main (not part of this task).** `.ai-sdlc/context-index.db` and the other `.ai-sdlc/` runtime paths the issue lists (`.worktrees/`, `.active-task`, `.ai-sdlc/transcripts/`, `.ai-sdlc/review-state/`, `.ai-sdlc/dispatch/`, `.ai-sdlc/verdicts/`) are in `RUNTIME_GITIGNORE_PATHS` since AISDLC-1331 (commit 9a94be18e, #2826, `orchestrator/src/runtime-gitignore.ts:22-45`). The issue was filed against a build before that. Doctor `runtime-gitignore` already checks the whole list and reports `fail` (`orchestrator/src/cli/commands/doctor-checks.ts:1366-1390`).

**Facts read in code** (main at 687e0d596).

- `orchestrator/src/runtime-gitignore.ts` has `.ai-sdlc/artifacts/` but no entry for `artifacts/` at the repository root. AISDLC-1331 left top-level `artifacts/` out of scope as "a project choice" (its Out of scope paragraph).
- `pipeline-cli/src/dor/calibration-log.ts:162-165` resolves the log to `$ARTIFACTS_DIR`, else `<cwd>/artifacts/_dor/calibration.jsonl`.
- `pipeline-cli/src/judgment/context.ts:48-54` `resolveJudgmentArtifactsDir` defaults to `<cwd>/artifacts`; `pipeline-cli/src/dor/composite.ts:152` passes it as the place where capability state is recorded, which gives `artifacts/_capabilities/state.json`. By contrast `reference/src/capabilities/state.ts:36-38` defaults to `.ai-sdlc/artifacts`, so two defaults disagree.
- This repository's own `.gitignore:103-113` ignores `artifacts/`, with a comment from AISDLC-122: the calibration log keeps issue titles and body previews that may quote pasted secrets.
- `pipeline-cli/src/steps/00-5-sync-parent.ts:172-185` lists untracked files with `git ls-files --others --exclude-standard`, and `:339-372` refuses any that is neither a backlog task nor a decision event.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the adopter needs one framework command not to block the next; the root `artifacts/` directory is the one place left that the framework writes and init does not ignore. 2. Deleted: nothing new to add to Step 0.5; making it tolerate runtime files stays out of scope. 3. Simplified or optimised: add entries to the one shared list that `init`, `execute` and doctor already read, so they cannot drift. 4. Accelerated: the first DoR check no longer leaves a file that blocks dispatch. 5. Automated: the existing doctor check and the shared-list test cover the new entries with no new code.

- Add the two directories the framework writes to `RUNTIME_GITIGNORE_PATHS`: `artifacts/_dor/` and `artifacts/_capabilities/` (interim value, see the open question).
- Add a test that runs the init scaffold, then `resolveCalibrationLogPath()` and `resolveJudgmentArtifactsDir()` with `ARTIFACTS_DIR` unset in a temp git repository, and asks `git check-ignore` about the resulting files.
- Keep the pipeline-cli paths unchanged. Out of scope: moving the default artifacts directory, making Step 0.5 tolerate runtime files.

Expected files: `orchestrator/src/runtime-gitignore.ts`, `orchestrator/src/runtime-gitignore.test.ts`, `orchestrator/src/cli/commands/doctor-checks.test.ts`, `orchestrator/src/cli/commands/init-workspace.test.ts`.

## Open questions for the operator

**Ignore the whole root `artifacts/`, only the two framework subdirectories, or move the default?** The calibration log may hold pasted secrets, so it must not be committable. An adopter may also keep a committed `artifacts/` of their own.

- Option A: ignore `artifacts/` (matches this repository's `.gitignore`). Simple, but it hides an adopter's own committed directory from `git add`.
- Option B: ignore `artifacts/_dor/` and `artifacts/_capabilities/` only. Narrow, but each new framework subdirectory needs an entry.
- Option C: change the pipeline-cli default to `.ai-sdlc/artifacts`, already ignored and the default in `reference/src/capabilities/state.ts`. Removes the cause, but moves existing logs and touches several readers.

Interim value the developer uses: option B. Recommendation: B now; C as a later task, since it also fixes the two disagreeing defaults.

## Acceptance Criteria

- [ ] #1 `RUNTIME_GITIGNORE_PATHS` contains `artifacts/_dor/` and `artifacts/_capabilities/`, and a test in `runtime-gitignore.test.ts` asserts it.
- [ ] #2 A test initialises a temp git repository with the init scaffold, writes the calibration log and capability state at their default paths with `ARTIFACTS_DIR` unset, and shows `git status --porcelain` lists neither.
- [ ] #3 A test shows `syncParentUntrackedFiles` returns `ok: true` in that repository after the two files exist.
- [ ] #4 A test in `doctor-checks.test.ts` shows `runtime-gitignore` fails for a `.gitignore` lacking the two entries and passes once they are present (via `doctor --fix`).
- [ ] #5 The pull request body names the choice made for the open question.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
