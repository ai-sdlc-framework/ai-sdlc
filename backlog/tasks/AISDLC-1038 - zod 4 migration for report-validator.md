---
id: AISDLC-1038
title: 'Dependency: migrate pipeline-cli to zod 4 (ZodError.errors to .issues) so the Dependabot zod bump can land'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/pipeline/report-validator.ts
  - pipeline-cli/package.json
priority: medium
dispatchable: true
---

## Description

Dependabot PR #1756 (zod 3.25.76 to 4.6.7) has been red since 2026-10-17. The real failure is a compile error, identical in Build & Test, First-run smoke and Integration Tests:

```
pipeline-cli build: src/pipeline/report-validator.ts(183,33): error TS2339: Property 'errors' does not exist on type 'ZodError<...>'
pipeline-cli build: src/pipeline/report-validator.ts(184,11): error TS7006: Parameter 'e' implicitly has an 'any' type.
```

Zod 4 renamed `ZodError.errors` to `ZodError.issues`. Bump zod to the 4.x line in every workspace package that declares it, adapt `report-validator.ts` and any other `.errors` reader, and run the zod 4 migration checklist (`z.string().email()` style deprecations, `.default` semantics) across `pipeline-cli`, `orchestrator` and the MCP server.

**Five-step review (requirements first).** Requirement questioned: does the repository need this dependency at the new version at all, or can the bump be dropped? Deletion: the stale Dependabot PR is not closed by us; once main carries the bump Dependabot retires it on its own. Simplified: one PR that bumps the package and adapts the code, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the exact compile or format error quoted below, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [ ] zod 4.x in `pnpm-lock.yaml` for every workspace package that depends on it; no package left on 3.x.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green locally and `ai-sdlc/pr-ready` green in CI.
- [ ] A test covers the validation-failure path of `report-validator.ts` and asserts the issue list is reported (it must fail on zod 3's `.errors` shape).
- [ ] PR body names Dependabot PR #1756 as superseded; nobody closes it by hand.
