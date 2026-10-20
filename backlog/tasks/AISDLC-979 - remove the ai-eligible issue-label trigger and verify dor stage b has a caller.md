---
id: AISDLC-979
title: 'Remove the ai-eligible issue-label trigger; verify DoR stage B has a caller'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - tooling
  - docs
dependencies: []
references:
  - orchestrator/src/admission-score.ts
  - pipeline-cli/src/dor/stage-b.ts
  - pipeline-cli/src/dor/composite.ts
  - docs/operations/dor-ingress-gate.md
  - docs/operations/backlog-and-execution-reference.md
priority: medium
dispatchable: true
---

## Description

No workflow under `.github/workflows/` references an `ai-eligible` issue label (verified 2026-10-20 by grep). The orchestrator admission code still carries it: `orchestrator/src/admission-score.ts:282-284` reads `labels.includes('ai-eligible')` as the explicit builder-conviction signal, and the adopter init template (`orchestrator/src/cli/commands/init.ts:72`) still emits the label in generated config. Operator decision (2026-10-20): the external-issue path is `/ai-sdlc execute gh:<n>` run by a local agent, never a CI trigger on a label. Delete the `ai-eligible` plumbing (admission signal, template line, the related tests that only exercise the label) and document the replacement path in `docs/operations/backlog-and-execution-reference.md` and `docs/operations/dor-ingress-gate.md` where the label or a CI-trigger path is implied.

Second part: DoR stage B (`pipeline-cli/src/dor/stage-b.ts:321`, `evaluateStageB`) looks like it may have no production caller. The call graph found on 2026-10-20 is `composite.ts:227` (and the corpus harness `corpus-e2e.ts:159`); the task verifies whether `composite.ts` itself is reached from a shipped entry point (`cli-dor-check`, the `dor-ingress` workflow, `ingress-claude.ts`) or only from tests and corpus tooling. If a production path exists, the task records it in the dor-ingress-gate doc and stops. If none exists, the task does NOT delete stage B; it files a decision record asking whether to delete it (class (b), `cli-decisions add` with `--timebox` and `--autonomous-fallback`) and leaves the code as is. The `rebase-resolver` and `ci-conflict-resolver` agents and `/ai-sdlc triage` have callers and stay.

**Five-step review (requirements first).**
1. Requirement questioned: is a label-driven CI trigger wanted at all? No; the operator chose the local `gh:<n>` path, so the label is dead config.
2. Delete: the `ai-eligible` admission signal, the template line and their label-only tests.
3. Simplify: one external-issue path (local execute), documented once.
4. Accelerate: no admission-score branch to maintain; no adopter confusion about a label that triggers nothing.
5. Automate: the stage B caller check is a one-time call-graph verification; its outcome (keep, or decision record) is recorded, not automated.

## Acceptance Criteria

- [ ] No source, template or test under `orchestrator/` or `pipeline-cli/` references the `ai-eligible` label; `pnpm build && pnpm test` pass.
- [ ] `docs/operations/backlog-and-execution-reference.md` and `docs/operations/dor-ingress-gate.md` describe `/ai-sdlc execute gh:<n>` as the only external-issue path and no longer imply a label trigger.
- [ ] The PR body states the verified call graph of `evaluateStageB` with file:line, and either names the production entry point or links the decision record filed for its deletion.
- [ ] Stage B code is not deleted in this task.
