---
id: AISDLC-262
title: init mis-targets monorepo roots
status: Done
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - init
  - monorepo
dependencies: []
priority: high
references:
  - orchestrator/src/cli/commands/init-features.ts
finalSummary: |
  ## Summary
  Fixed `ai-sdlc init` to resolve the install target via `git rev-parse
  --show-toplevel` by default instead of using `process.cwd()` blindly. When
  run from a subdirectory inside a git repo, init now installs at the git root.
  If the root already has `.ai-sdlc/`, init refuses with a clear
  "already installed at <root>; pass --workspace <name>" message. The
  `--workspace <name>` flag opts into a per-workspace install at
  `packages/<name>/.ai-sdlc/`. Dry-run output prints the resolved target
  on the first line.

  ## Changes
  - `orchestrator/src/cli/commands/init-features.ts` (modified): added
    `resolveInstallTarget()` with `InstallTargetResult` and
    `ResolveInstallTargetOptions` types; added `workspace?` field to
    `WizardFlags`; added `execSync` import.
  - `orchestrator/src/cli/commands/init.ts` (modified): imports and calls
    `resolveInstallTarget()`; added `--workspace <name>` CLI option; passes
    `skipExistingCheck: true` for `--add` path.
  - `orchestrator/src/cli/commands/init-workspace.test.ts` (modified): added
    6 unit tests for `resolveInstallTarget` (all AC scenarios) + 4 integration
    tests; updated AISDLC-104 test to reflect new correct behavior; added
    `workspace` to `runInit` reset.
  - `orchestrator/src/cli/commands/commands.test.ts` (modified): added
    `workspace` to `resetInitCommandOptions`; updated "skips files that already
    exist" mock to use path-aware logic so the nesting guard does not misfire.

  ## Design decisions
  - **`skipExistingCheck` on `--add` path**: the `--add <feature>` extension
    path intentionally extends an already-initialized repo, so the nesting
    guard must be suppressed. Passing the flag explicitly makes the opt-out
    visible at the call site rather than hiding it inside the resolver logic.
  - **`packages/` heuristic for `--workspace`**: when `packages/` exists under
    the git root, `--workspace <name>` installs at `packages/<name>/`; when
    absent, it installs at `<git-root>/<name>/`. This covers both npm/pnpm
    workspace conventions without requiring the operator to spell out the full
    path.

  ## Verification
  - `pnpm build` (orchestrator) -- clean
  - `pnpm exec vitest run` (orchestrator) -- 3109 tests passed, 158 files
  - `pnpm lint` -- 0 errors, 2 pre-existing warnings (unrelated)
  - `pnpm format:check` -- clean

  ## Follow-up
  - Consider adding a prompt when the git root is detected and there is no
    existing `.ai-sdlc/` there but the operator appears to be inside a
    monorepo child (pnpm-workspace.yaml / lerna.json / nx.json present at
    root) — AC #3 "Ask which workspace" path from the task spec.
---

## Bug

Run from a workspace root that already has an `.ai-sdlc/` directory, the `ai-sdlc init` dry-run still picks a workspace child (e.g. `packages/frontend/.ai-sdlc/`) as the install target instead of recognizing the root.

## Repro (forge)

```bash
cd /Users/dominique/Documents/dev/forge   # workspace root with existing .ai-sdlc/ + packages/
ai-sdlc init --dry-run
# → reports `packages/frontend/.ai-sdlc/` as the target instead of the root
```

## Expected behavior

`ai-sdlc init` should detect a workspace-root install context and either:

1. **Refuse to nest**: if `<repo-root>/.ai-sdlc/` already exists, refuse and tell the operator to delete the duplicate they're trying to create OR pass `--workspace <name>` if they really want a per-workspace install.
2. **Resolve to git root**: walk up from `cwd` to the nearest `.git/` (or `.git` worktree-link file) and target that root unless `--workspace <name>` is passed.
3. **Ask which workspace**: when `pnpm-workspace.yaml` / `lerna.json` / `nx.json` indicate a workspace AND there's no existing `.ai-sdlc/`, prompt the operator (or auto-pick root with `--yes`).

## Acceptance criteria

- [x] `ai-sdlc init` from any directory inside a git repo resolves the install target via `git rev-parse --show-toplevel` by default (option 2).
- [x] When `<repo-root>/.ai-sdlc/` already exists, init refuses with a clear "AI-SDLC is already installed at <root>; pass --workspace <name> to add a child install" message.
- [x] `--workspace <name>` flag opts into the per-workspace install at `packages/<name>/.ai-sdlc/`.
- [x] Dry-run output prints the resolved target path ON THE FIRST LINE so adopter can sanity-check before committing.
- [x] New tests in `orchestrator/src/cli/commands/init-workspace.test.ts` exercise: workspace-root with existing .ai-sdlc/, workspace child, plain repo, non-git dir.

## Source

Adopter session 2026-05-13, ranked #2 by friction (forge integration).
