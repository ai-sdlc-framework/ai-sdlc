---
id: AISDLC-975
title: 'Replace the remaining raw gh auto-arm calls with the merge-if-eligible path'
status: In Progress
assignee: []
created_date: '2026-10-20'
labels:
  - trust-chain
  - tooling
dependencies: []
references:
  - pipeline-cli/src/cli/resume-from-draft.ts
  - pipeline-cli/src/orchestrator/reconcile.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/bin/cli-merge-if-eligible.mjs
priority: high
dispatchable: true
---

## Description

Governance (`.ai-sdlc/agent-role.yaml`, `allowMerge: onGreenClean`) says auto-merge is armed only through `cli-merge-if-eligible --arm`, which checks the policy, fork, author, base, task and head commit before touching the PR. Four source sites still issue the raw gh auto-arm call directly: `pipeline-cli/src/cli/resume-from-draft.ts:135` (the re-arm helper: `runner('gh', [...])` with the auto-arm subcommand and `--auto`) and `:596` (the same call after an APPROVED verdict), `pipeline-cli/src/orchestrator/reconcile.ts:931` (`spawn('gh', [...])` with the auto-arm subcommand, `--auto` and `--squash`), and `pipeline-cli/src/execute-pipeline.ts:610` (Step 11 auto-promote, same shape as the resume helper). Each one bypasses every eligibility check and swallows the non-zero exit, so a PR the gate would refuse can be armed by the pipeline itself.

Fix: each site calls the merge-if-eligible module (`pipeline-cli/src/governance/merge-if-eligible.ts`, the same code `cli-merge-if-eligible.mjs` runs) with `--arm` semantics and the right source kind, and a refusal is logged with the gate's reason instead of being swallowed. A test asserts that no non-test source file outside the merge-if-eligible module builds a gh invocation whose `pr` subcommand is the merge verb (a grep-style test over `pipeline-cli/src` and `orchestrator/src` is enough; the adopter template in `orchestrator/src/cli/commands/init-templates.ts:883` is either rewritten to call the CLI or excluded with a comment naming why).

**Five-step review (requirements first).**
1. Requirement questioned: do the pipeline sites need their own arm at all? The resume and auto-promote paths do need to arm; the orchestrator reconcile path duplicates what the hierarchy reconciler already does through the CLI and may be deleted outright if nothing calls it.
2. Delete: the raw arm helper in `resume-from-draft.ts` and the duplicate in `orchestrator/reconcile.ts` if its caller is gone.
3. Simplify: one arming function, one source-kind argument, no per-site retry logic.
4. Accelerate: a refused arm now prints the gate reason at once instead of leaving the PR silently un-armed for a dispatch tick to find.
5. Automate: the grep-style test keeps the invariant without a reviewer having to remember it.

## Acceptance Criteria

- [ ] `resume-from-draft.ts`, `orchestrator/reconcile.ts` and `execute-pipeline.ts` no longer invoke the raw gh auto-arm call; each routes through the merge-if-eligible module with `--arm` semantics.
- [ ] A refused arm surfaces the gate's reason in the log and in the step result instead of a swallowed non-zero exit.
- [ ] A test asserts no non-test source under `pipeline-cli/src` or `orchestrator/src`, other than the merge-if-eligible module, contains a gh invocation whose `pr` subcommand is the merge verb.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
