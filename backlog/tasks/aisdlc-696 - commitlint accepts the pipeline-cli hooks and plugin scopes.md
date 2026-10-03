---
id: AISDLC-696
title: >-
  commitlint: accept the pipeline-cli, hooks and plugin scopes
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - dx
  - hooks
dependencies: []
references:
  - commitlint.config.mjs
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The commit lint rule's `scope-enum` lists `reference`, `conformance`, `sdk`,
`sdk-typescript`, `orchestrator`, `mcp-advisor`, `sdk-python`, `sdk-go`, `dashboard`,
`dogfood`, `deps`, `ci`, `spec` and `docs`. Executors routinely write `pipeline-cli` and
`hooks`, which the rule rejects; two such commits merged unchecked on 2026-10-03
because their worktrees had no hooks.

Operator decision, 2026-10-03: add the scopes in use, so a commit can name the package
it touches.

## Scope
1. Add `pipeline-cli`, `hooks` and `plugin` to `scope-enum` in `commitlint.config.mjs`.
2. Keep every existing scope and keep unscoped commits allowed.

## Acceptance Criteria
- [ ] `fix(pipeline-cli): x`, `fix(hooks): x` and `feat(plugin): x` pass commitlint; `fix(nonsense): x` still fails.
- [ ] A header with no scope still passes.
- [ ] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
