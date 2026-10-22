---
id: AISDLC-1039
title: 'Dependency: web-tree-sitter 0.27 no longer loads the grammars in tree-sitter-provider; fix the loader or pin the package out of the production group'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/review-risk-map/tree-sitter-provider.ts
  - pipeline-cli/src/review-risk-map/tree-sitter-provider.test.ts
  - .github/dependabot.yml
priority: medium
dispatchable: true
---

## Description

Dependabot PR #1763 (production-minor-patch group, 5 updates) is red only because of web-tree-sitter 0.25.10 to 0.27.1. The other four bumps (js-yaml, @inquirer/prompts, next, @modelcontextprotocol/sdk) pass. Real failure:

```
FAIL src/review-risk-map/tree-sitter-provider.test.ts > TreeSitterStructuralProvider: callers, callees and tests > TypeScript: ...
Error: unavailable: no-grammar
src/review-risk-map/tree-sitter-provider.test.ts (25 tests | 21 failed)
```

web-tree-sitter 0.27 changed how the wasm runtime and grammars are located and initialised (0.x minors are breaking). Decide by evidence: either adapt the grammar loader in `tree-sitter-provider.ts` to the 0.27 API (preferred when the change is under ~50 lines), or add an `ignore` entry for web-tree-sitter minor updates in `.github/dependabot.yml` with a comment naming this task so the group PR lands without it.

**Five-step review (requirements first).** Requirement questioned: does the repository need this dependency at the new version at all, or can the bump be dropped? Deletion: the stale Dependabot PR is not closed by us; once main carries the bump Dependabot retires it on its own. Simplified: one PR that bumps the package and adapts the code, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the exact compile or format error quoted below, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [ ] Either web-tree-sitter 0.27.x is in the lockfile with all 25 provider tests green, or dependabot.yml ignores its minor bumps and the reason is written next to the ignore.
- [ ] The remaining four bumps of the group are on main (bumped in this PR, or by letting Dependabot regroup after the ignore).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
- [ ] PR body names Dependabot PR #1763 as superseded; nobody closes it by hand.
