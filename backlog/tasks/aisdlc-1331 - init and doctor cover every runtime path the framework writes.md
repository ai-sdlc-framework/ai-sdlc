---
id: AISDLC-1331
title: 'Init and doctor cover every runtime path the framework writes'
status: To Do
assignee: []
created_date: '2026-11-19'
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
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/init-workspace.test.ts
  - orchestrator/src/execute.ts
  - orchestrator/src/execute.gitignore.test.ts
priority: high
dispatchable: true
dispatchableReason: 'Bounded to one shared list, the init and execute writers, one doctor check and their tests.'
---

## Description

**Gap.** The `.gitignore` block that `ai-sdlc init` writes names only five runtime paths. The framework writes many more, and in an adopter project each one that is not ignored shows up as untracked. The first untracked file makes the clean-parent check (Step 0.5) refuse to dispatch. Doctor does not notice, because its `runtime-gitignore` check looks at one path only.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18 and 2026-11-19): Step 0.5 aborted on `.ai-sdlc/subagent-sessions/*.json`, then on `.ai-sdlc/transcripts/**` and `.worktrees/<task>/`. It then reported `.ai-sdlc/dispatch/*`, `.ai-sdlc/context-index.db`, `.claude/memory/*` and `artifacts/*` as "non-backlog untracked files ... manual cleanup required". The block in that project's `.gitignore` held only `state.db`, `state/`, `audit.jsonl` and `artifacts/` under `.ai-sdlc/`. In a task worktree `git status` also showed `.active-task`, `.ai-sdlc/.last-build-sha`, `.ai-sdlc/review-state/` and `.ai-sdlc/verdicts/*.json`. Doctor passed.

**Cause (read from the source).**

- `orchestrator/src/runtime-gitignore.ts:23-30` holds the whole list: `.ai-sdlc/state.db`, `.ai-sdlc/state/`, `.ai-sdlc/audit.jsonl`, `.ai-sdlc/artifacts/`, `.ai-sdlc/subagent-sessions/`. The last one was added by AISDLC-1260; nothing else was added since the list was created.
- `orchestrator/src/cli/commands/init.ts:389-412` (`ensureGitignore`) and `orchestrator/src/execute.ts:1700-1725` (`ensureRuntimeGitignore`) write exactly that list and nothing more.
- This monorepo's own `.gitignore` ignores the missing paths (`.ai-sdlc/dispatch/`, `.ai-sdlc/transcripts/`, `.ai-sdlc/verdicts/`, `.ai-sdlc/review-state/`, `.ai-sdlc/context-index.db` with its `-wal` and `-shm`, `.ai-sdlc/context/sessions/`, `.ai-sdlc/.last-build-sha`, `.active-task`, `.worktrees/`, `.ai-sdlc/captures-drafts/`, `.ai-sdlc/sweep-landed-cache.json`), so the problem never shows here.
- `orchestrator/src/cli/commands/doctor-checks.ts:1141-1167` (`checkRuntimeGitignore`) tests only `ARTIFACTS_GITIGNORE_ENTRY`. It reports `warn`, never `fail`, and has no `fix` (registration at `doctor-checks.ts:3037-3041`).
- `pipeline-cli/src/steps/00-5-sync-parent.ts:172-185` lists untracked files with `git ls-files --others --exclude-standard`, and `:339-372` refuses on any that is neither a backlog task file nor a decision event. So every unignored runtime file blocks dispatch.
- Writers of the missing paths, for the record: `pipeline-cli/src/knowledge/config.ts:67` (`.ai-sdlc/context-index.db`), `pipeline-cli/src/hierarchy/trusted-root.ts:129` (`.ai-sdlc/dispatch`), `pipeline-cli/src/steps/ensure-workspace-built.ts:26` (`.ai-sdlc/.last-build-sha`), `pipeline-cli/src/capture/draft-capture.ts` (`captures-drafts`), `pipeline-cli/src/steps/00-sweep.ts` (`sweep-landed-cache`).
- `pipeline-cli/src/next-step/ship.ts:68` keeps a separate hint list of three paths. It is a note in an error message, not a writer of `.gitignore`.

**Shape.** `orchestrator/src/runtime-gitignore.ts` holds the one list. It names every runtime path the framework writes inside a project and that is not meant to be committed, taken from the list above and checked against its writer. `init` writes all of it, a re-run of `init` adds what is missing under the existing sentinel block, and `ai-sdlc execute` repairs it as before. Doctor's `runtime-gitignore` check asks git about every entry in the list and reports `fail` that names each missing one. `doctor --fix` adds them the same way `init` does. A repository whose `.gitignore` already covers an entry by a broader line is not touched, as today.

**Control.** No control changes. The ignore list only grows for files the framework itself writes and nobody reviews. The doctor check goes from `warn` on one path to `fail` on any missing path.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a short list was enough while the framework wrote few files; nothing asks for a project to hand-maintain its ignore rules for framework output. 2. Deleted: the separate idea of "the artifacts entry" as the only checked path. 3. Simplified or optimised: one exported list feeds `init`, `execute` and doctor, so they cannot drift. 4. Accelerated: dispatch stops being blocked on the first run, instead of one path per failed attempt. 5. Automated: doctor detects a missing entry and `doctor --fix` repairs it; a test ties every entry in this repository's own runtime block to the shared list so a new runtime path cannot be added in one place only.

- **One list.** Extend `RUNTIME_GITIGNORE_PATHS` with the paths named in the Gap and Cause that have a writer in this repository: the `.ai-sdlc/` entries (`dispatch/`, `transcripts/`, `verdicts/`, `review-state/`, `context-index.db`, `context-index.db-wal`, `context-index.db-shm`, `context/sessions/`, `.last-build-sha`, `captures-drafts/`, `sweep-landed-cache.json`, `state.db-wal`, `state.db-shm`), plus `.active-task` and `.worktrees/`. Drop any entry for which no writer exists on `main`.
- **Doctor.** `checkRuntimeGitignore` loops over the list, uses `gitCheckIgnoreArgs` per entry, returns `fail` listing the missing ones, and gets a `fix` that calls the shared insert helper.
- **Init and execute.** No change in logic beyond using the longer list; extend their tests to the new entries, including a re-run on a block written by an older release.
- **Test.** A test reads this repository's `.gitignore` and checks that each `.ai-sdlc/` runtime entry it holds appears in the shared list or in a named exception list in the test.

Out of scope: `.claude/memory/` and top-level `artifacts/` (whether an adopter ignores them is a project choice, filed as a question); `pipeline-cli/src/next-step/ship.ts` hint list; making Step 0.5 tolerate runtime files; `.claude/transcripts/` (written by this repository's own hook, not the plugin).

## Acceptance Criteria

- [ ] #1 A test asserts that `RUNTIME_GITIGNORE_PATHS` contains every entry named in the Fix bullet "One list".
- [ ] #2 A test runs `init` on an empty repository and checks that `git check-ignore` reports every entry in the list as ignored.
- [ ] #3 A test re-runs `init` on a `.gitignore` that holds the old five-entry block and checks that the missing entries are added under the same sentinel block and no second block appears.
- [ ] #4 A test runs `checkRuntimeGitignore` on a repository with the old five-entry block: severity is `fail` and the message names each missing entry, including `.ai-sdlc/dispatch/` and `.ai-sdlc/transcripts/`.
- [ ] #5 A test runs `checkRuntimeGitignore` on a repository covering every entry (directly or by a broader line such as `.ai-sdlc/*`): severity is `pass`.
- [ ] #6 A test runs the check's `fix` on the old block and then the check again: `pass`, and a second `fix` run changes nothing.
- [ ] #7 A test compares this repository's `.gitignore` runtime entries with the shared list and fails on an `.ai-sdlc/` entry that is in neither the list nor the named exceptions.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
