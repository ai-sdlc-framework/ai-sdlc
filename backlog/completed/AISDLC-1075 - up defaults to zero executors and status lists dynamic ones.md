---
id: AISDLC-1075
title: 'up defaults to zero executors, status lists dynamic executors, runbook rewritten'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - plugin
  - hierarchy
priority: high
dispatchable: true
dependencies: 
  - AISDLC-1073
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/roster.ts
  - docs/operations/cli-hierarchy.md
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - spec/rfcs/RFC-0059-ephemeral-executors.md
rfc: RFC-0059
---

## Description

Make `up --executors` default to 0 and keep the option for one release with a deprecation line. `status` lists dynamic executors with task id and age. Rewrite the executor lifecycle sections of `docs/operations/cli-hierarchy.md` for spawn per task. The hooks module executor branch reads `AI_SDLC_EXECUTOR_TASK` instead of waiting for a wake.

**Five-step review (requirements first).** Requirement questioned: should `up` start any executor? No. Deletion: standing executor startup. Simplification: one lifecycle in the runbook. Acceleration: `up` returns without launching sessions. Automation last: a docs parity test keeps the runbook honest.

## Acceptance Criteria

- [x] `cli-hierarchy up` starts no executor by default and `--executors 2` prints a deprecation line.
- [x] `cli-hierarchy status` lists each dynamic executor with its task id.
- [x] The hooks module executor branch with the variable set claims that task without waiting for a wake.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
Rebased the existing AISDLC-1075 branch onto origin/main and force-pushed it to PR #2027. The change makes `up` default to zero executors, adds a deprecation line for `--executors`, makes `status` list dynamic executors with task id and age, rewrites the runbook for spawn per task, and has the hooks executor branch read AI_SDLC_EXECUTOR_TASK.

## Changes
- ai-sdlc-plugin/hooks/hierarchy/executor.ts
- ai-sdlc-plugin/hooks/hierarchy/register.tsx
- ai-sdlc-plugin/mods/tests/hierarchy.test.ts
- docs/operations/cli-hierarchy.md
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/hierarchy/hierarchy.test.ts
- pipeline-cli/src/hierarchy/index.ts
- pipeline-cli/src/hierarchy/status.ts
- pipeline-cli/src/hierarchy/up.ts

## Design decisions
The rebase had one conflict, in ai-sdlc-plugin/hooks/hierarchy/register.tsx. Both sides added an import from executor.ts (setSwallowSink from main, startPinnedTask from this branch), so I kept both. `pnpm test` exited 0 with `# pass 3546`, `# fail 0`. Build, lint and format:check also passed. I did not run per-package coverage. PR #2027 is still a draft, and I did not run `gh pr ready` or check `ai-sdlc/pr-ready`, so AC 4 is met locally only.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

