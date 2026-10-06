---
id: AISDLC-730
title: >-
  Untrusted-run signal: make it survive child agents and cover every outside-triggered path
status: Done
assignee: []
created_date: '2026-10-05'
labels:
  - security
  - governance
dependencies:
  - AISDLC-720
references:
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - pipeline-cli/src/runtime/untrusted-env.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/cli/rework-pr.ts
  - .github/workflows/ai-sdlc.yml
  - docs/api-reference/governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to AISDLC-720 (merged, PR #1211). AISDLC-720 treats a run as untrusted when `AI_SDLC_UNTRUSTED_RUN` is truthy, or when `GITHUB_ACTIONS` is truthy and `AI_SDLC_INTERNAL_RUN` is not truthy (`isUntrustedRun` in `ai-sdlc-plugin/hooks/lib/governance-resolver.js`). The Opus security review of that PR listed these gaps as tracked follow-ups:

1. A child agent can drop the signal, for example a `claude -p` child started with the variable cleared.
2. The rework-pr path (`pipeline-cli/src/cli/rework-pr.ts`) and the inline-taskSpec path do not mark the run untrusted.
3. The issue workflow (`.github/workflows/ai-sdlc.yml`, label `ai-eligible`) runs `dogfood execute --issue N` through the Orchestrator class and not `executePipeline`, so the producer added in 720 (`withUntrustedEnv` in `pipeline-cli/src/runtime/untrusted-env.ts`, applied for sourceKind gh-issue in `pipeline-cli/src/execute-pipeline.ts`) never applies there. The external-PR review workflow sets no signal either.
4. Low: CI systems other than GitHub Actions are not detected and fail open (documented in 720).

This task closes 1 to 3 and decides what to do about 4 (detect further CI systems, or keep the documented limit with the reason).

Finding 2026-10-05: the blocked-actions hook reads the policy from the main checkout's WORKING COPY of `.ai-sdlc/agent-role.yaml`, not from a committed revision, so an uncommitted local edit changes what agents may touch; assess whether the hook should read the committed policy (HEAD) for trust decisions.

## Conventions
- The workflow side sets `AI_SDLC_INTERNAL_RUN` only in step-level `env`, never through `$GITHUB_ENV`, and sets the untrusted signal explicitly on jobs that take outside input.
- The workflow edits in this task need the repository's blockedPaths change (the operator's agent-role.yaml edit that the planner tracks as the second item of DEC-0057; it has no task file on main yet, so it is not listed in `dependencies`) applied first. The rest can land before it.
- Hermetic tests; temporary directories from `mkdtemp`.

## Acceptance Criteria
- [x] Design chosen and justified in the PR body: the untrusted state cannot be cleared by a descendant process (for example a marker outside the environment that the hook re-derives, rather than an environment variable a child can unset).
- [x] Every entry path that takes outside input sets the signal, with one test per path: gh-issue execution, rework-pr, inline taskSpec, the issue workflow, and the external-PR review workflow.
- [x] The issue workflow runs the Orchestrator path with the signal set, shown by a test over `.github/workflows/ai-sdlc.yml`.
- [x] Workflow side: `AI_SDLC_INTERNAL_RUN` appears only in step-level `env` and never via `$GITHUB_ENV`; a workflow test asserts both. Applied once the blockedPaths change is in.
- [x] A child agent started with the environment cleared is still treated as untrusted (test).
- [x] Regression test: local operator and executor sessions keep editing `.ai-sdlc/` with zero prompts.
- [x] Item 4 decided: either other CI systems are detected, or the limit stays documented with the reason.
- [x] `docs/api-reference/governance.md` updated.

## Velocity impact
Prevents an outside-triggered run from regaining the right to edit `.ai-sdlc/` config by dropping or clearing its own signal. The happy path (operator and executor sessions) gets zero new prompts, asserted by the regression test. When refused, the agent gets a message naming the blocked path and the fact that the run is marked untrusted; it should stop, report, and not retry with a modified environment.
<!-- SECTION:DESCRIPTION:END -->
