---
id: AISDLC-1075
title: 'up defaults to zero executors, status lists dynamic executors, runbook rewritten'
status: To Do
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

- [ ] `cli-hierarchy up` starts no executor by default and `--executors 2` prints a deprecation line.
- [ ] `cli-hierarchy status` lists each dynamic executor with its task id.
- [ ] The hooks module executor branch with the variable set claims that task without waiting for a wake.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
