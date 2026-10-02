---
id: AISDLC-654.2
title: >-
  RFC-0050 follow-up: anchor the artifacts directory at the project root so routing assignments survive worktree cleanup
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - model-routing
  - plugin
  - pipeline-cli
dependencies:
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/steps/07-build-review-prompts.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from an executor or reviewer report on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Finding from AISDLC-657.2: `ai-sdlc-plugin/commands/execute.md` passes
`--artifacts-dir "${ARTIFACTS_DIR:-$WORKTREE_PATH/.ai-sdlc/artifacts}"` on the
developer, reviewer and skip-log routes, and steps 05 and 07 call
`routingArtifactsDir(worktreePath)`, so the routing assignment log lands under
`<parent>/.worktrees/<id>/.ai-sdlc/artifacts` and is deleted with the worktree. The
scorecard reads the parent's artifacts directory, so its view of pipeline runs stays
empty unless `ARTIFACTS_DIR` is exported by hand. Touches a plugin command, so review
is trust-sensitive.

## Scope
1. Resolve the project root once per run (for example from
   `git rev-parse --path-format=absolute --git-common-dir`, stripping the `.git`
   suffix) and use `<project-root>/.ai-sdlc/artifacts` as the default artifacts
   directory when `ARTIFACTS_DIR` is unset, on every route in `execute.md`.
2. Pass the same resolved value to `resolve-model` and to the step options, and
   change `routingArtifactsDir` in steps 05 and 07 to take the project root rather
   than the worktree path.
3. Keep `ARTIFACTS_DIR` as the explicit override. Document the default in the usage
   runbook's routing section.
4. A worktree-local artifacts directory that already exists is left in place; nothing
   is moved or deleted.

## Acceptance Criteria
- [ ] In a Pattern C layout fixture, a run from a worktree writes the assignment log under the parent's `.ai-sdlc/artifacts`, and the scorecard sees it.
- [ ] `ARTIFACTS_DIR` set explicitly still wins on every route.
- [ ] Steps 05 and 07 receive the project root and produce identical paths to the command's default (asserted in a test).
- [ ] The runbook documents the default and the override.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
