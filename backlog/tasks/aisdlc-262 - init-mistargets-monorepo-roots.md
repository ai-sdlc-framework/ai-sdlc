---
id: AISDLC-262
title: init mis-targets monorepo roots
status: To Do
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

- [ ] `ai-sdlc init` from any directory inside a git repo resolves the install target via `git rev-parse --show-toplevel` by default (option 2).
- [ ] When `<repo-root>/.ai-sdlc/` already exists, init refuses with a clear "AI-SDLC is already installed at <root>; pass --workspace <name> to add a child install" message.
- [ ] `--workspace <name>` flag opts into the per-workspace install at `packages/<name>/.ai-sdlc/`.
- [ ] Dry-run output prints the resolved target path ON THE FIRST LINE so adopter can sanity-check before committing.
- [ ] New tests in `ai-sdlc-plugin/scripts/init.test.mjs` exercise: workspace-root with existing .ai-sdlc/, workspace child, plain repo, non-git dir.

## Source

Adopter session 2026-05-13, ranked #2 by friction (forge integration).
