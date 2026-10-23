---
id: AISDLC-1078
title: 'step 6 runs the verify commands itself and gates on exit status, not on the developer subagent self-reported verifications'
status: To Do
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - token-cost
  - workflow-audit-2026-10-18
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/review-plan/executor.ts
  - docs/operations/workflow-engine.md
---

## Description

Workflow graph audit of 2026-10-18, finding 4 (anchor), the one finding of the sixteen with no task. Step 6 of the execute pipeline gates on the developer subagent's self-reported `verifications{build,test,lint,format}` JSON; the first anchor that cannot argue back is CI, after review, signing and pushing. A developer that reports green on a red tree costs one full reviewer fan-out, a sign, a push, a CI run and a reenter round before the truth surfaces; on the weekly token audit of 2026-10-23 reviewer and reenter rounds are the second largest executor cost after idle polling. The staged review's `tests-run` probe already shows the cheap pattern: code runs the command and records the exit status.

Fix: step 6 runs the task's `verifyCommands` (from the dispatch manifest, default `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check`) in the task worktree through the existing process runner with a timeout per command (config key, default 20 minutes), captures exit status and the last 60 lines of output, and writes them to the run state as the authoritative `verifications`; the developer's self-report is kept only as `developerClaimed` for the record. A non-zero exit sends the run back to step 5 with the failing command and tail as developer feedback, counted against the iteration cap, without invoking any reviewer. A developer return that reports green while code finds red is logged as a developer-honesty event in the usage ledger. Skip the run when the manifest sets `verifyCommands: []` (docs-only tasks) and say so in the run state. When the workflow engine (RFC-0056) is the default, the same step node carries this behaviour; do not implement it twice.

**Five-step review (requirements first).** Requirement questioned: should the developer report verifications at all? Only as a claim; the gate is the exit status. Deletion: the trust in the JSON. Simplified: one runner call per command, one record. Accelerated: a red tree never reaches the reviewers, the signer or CI. Automated last: the honesty event feeds the ledger for later model routing.

## Acceptance Criteria

- [ ] With a fake worktree whose `pnpm test` exits 1 and a developer return claiming all green, step 6 routes to step 5 with the failing command and output tail as feedback, no reviewer prompt is built, and the run state records both `verifications` (code) and `developerClaimed`.
- [ ] With all commands exiting 0, the run proceeds to step 7 unchanged; with `verifyCommands: []` the step records `skipped: docs-only` and proceeds; a per-command timeout is enforced (test with a sleeping command).
- [ ] Runbook updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
