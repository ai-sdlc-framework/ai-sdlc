---
id: AISDLC-1407
title: 'Setup and init repair the runtime gitignore block on every run'
status: Done
assignee: []
created_date: '2026-11-24'
labels:
  - adopter
  - setup
  - orchestrator
dependencies: []
references:
  - orchestrator/src/cli/commands/setup.ts
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/runtime-gitignore.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - pipeline-cli/src/cli/init.ts
priority: high
---

## Description

**Five-step review (requirements first).** An adopter repository must ignore the framework's runtime files (state database, dispatch board, worktrees, context index, protected knowledge). That requirement holds: without it runtime files show as untracked and protected knowledge can be committed. Nothing to delete. Simplest fix: call the writer that already exists from the paths that skip it; add no second list and no new mechanism.

**Gap (found 2026-11-24 in the ai-sdlc-enterprise adopter, plugin 0.44.0).** After a plugin update and a re-run of `/ai-sdlc:setup`, `.gitignore` had none of the entries in `RUNTIME_GITIGNORE_PATHS` and no `# ai-sdlc:runtime-gitignore` block; `.ai-sdlc/state.db`, `.ai-sdlc/dispatch/` and `.ai-sdlc/artifacts/` showed as untracked.

- `setup.ts` (about line 305) skips the init step when `.ai-sdlc/pipeline.yaml` exists; `repairSteps` only re-checks the gate workflow and branch protection.
- `ensureGitignore` (`init.ts`) is called only from `initProject`, the first-time path; the `init --add` path returns before it.
- Setup runs `doctor` without `--fix`, so the `runtime-gitignore` check reports and changes nothing.
- The manifest-based `/ai-sdlc:init` (`pipeline-cli` `cli-init`) has no `.gitignore` handling at all.
- `RUNTIME_GITIGNORE_PATHS` has the context index files but not `.ai-sdlc/knowledge-protected/`, the protected knowledge root (`pipeline-cli/src/knowledge/config.ts`). `cli-context check-scope` fails when that root is not ignored, and data-room capture writes protected entries there.

## Fix

- `setup` repair path: add a step that runs the existing managed-block writer (`ensureGitignore` or `fixRuntimeGitignore`) on every run and reports it as done or already present, listing the entries it added.
- `init --add`: call the same writer before returning.
- Manifest-based `/ai-sdlc:init`: write the same block. Use one list; if `pipeline-cli` cannot import the orchestrator's list, move the list to where both can read it. Do not copy it.
- Add `.ai-sdlc/knowledge-protected/` to `RUNTIME_GITIGNORE_PATHS`.
- The writer stays append-only inside its marker block and never removes or reorders an adopter's own lines.

## Acceptance Criteria

- [ ] #1 Test: `setup` on a project that has `.ai-sdlc/pipeline.yaml` and a `.gitignore` without the block adds the block with every entry; a second run changes nothing.
- [ ] #2 Test: `init --add` and the manifest-based init each add the missing entries and keep existing lines untouched.
- [ ] #3 Test: the list contains `.ai-sdlc/knowledge-protected/`, and the doctor `runtime-gitignore` check fails without it.
- [ ] #4 One list of runtime paths in the source; no second copy.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
