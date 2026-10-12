---
id: AISDLC-812
title: >-
  hierarchy up launches every session under the pinned Node (nvm 22.23.2), and status flags a session on the wrong Node
status: Done
assignee: []
created_date: '2026-10-11'
labels:
  - hierarchy
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/hierarchy.test.ts
  - docs/operations/cli-hierarchy.md
  - .nvmrc
  - package.json
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context.** On 2026-10-11 the AISDLC-801 executor ran under Node v22.19.0 while root `package.json` `engines.node` is `>=22.22.1`. Step 3's hooks install failed and left an empty branch (decision DEC-0113; see also AISDLC-762.1). DEC-0060 (2026-10-05) decided to change the machine default to 22.23.2 but it was never applied, and `cli-hierarchy up` (`buildClaudeCommand` in `pipeline-cli/src/hierarchy/up.ts`, with the launch env prefix from AISDLC-791) inherits whatever Node the launching shell has. Note: `.nvmrc` currently reads 22.22.1; this task decides whether to bump it to 22.23.2 per DEC-0060 so that `.nvmrc` is the single source of truth.

**Five-step review (requirements first).**
1. Requirement questioned: "sessions run the engines Node" is real (hooks, the lint-staged floor).
2. Delete the dependence on the operator's shell default.
3. Simplify: `up` prefixes each session command with the nvm activation for the version in `.nvmrc` (or an explicit `--node <version>`), and fails closed when that version is not installed. `status` shows each session's Node version, read via the pane's process, and flags a mismatch.
4. Accelerate / 5. Automate: no manual `nvm use` before launching; mismatches surface in `status` instead of mid-task failures.

**Velocity impact.** Positive: removes a class of Step 3 and hooks failures caused by the wrong Node.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A `buildClaudeCommand` test shows the nvm activation prefix resolving the version from `.nvmrc`
- [ ] #2 `up` refuses with a clear message naming the missing version and the `nvm install` next step when that version is not installed
- [ ] #3 `status` has a Node version column per session with a mismatch flag, covered by a test
- [ ] #4 `docs/operations/cli-hierarchy.md` documents the pinned Node, `--node`, and the status column
- [ ] #5 The five steps are named in the task body
- [ ] #6 `pnpm build && pnpm --filter @ai-sdlc/pipeline-cli test`, `pnpm lint` and `pnpm format:check` pass
<!-- AC:END -->
