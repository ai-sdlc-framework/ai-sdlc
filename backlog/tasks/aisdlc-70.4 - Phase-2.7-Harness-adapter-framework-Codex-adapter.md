---
id: AISDLC-70.4
title: 'Phase 2.7: Harness adapter framework + Codex adapter'
status: To Do
assignee: []
created_date: '2026-04-26 19:45'
labels:
  - rfc-0010
  - phase-2.7
  - harness
milestone: m-2
dependencies:
  - AISDLC-70.1
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#13-harness-selection
  - ai-sdlc-plugin/agents/critic-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
HarnessAdapter framework (RFC §13) decoupling the orchestrator from any single coding-agent runtime. Ships two adapters: claude-code (refactor of today's hardcoded path, no behavior change) and codex (new). Folds in Q6 (capability discovery via static declaration + version probe), Q7 (schema-conformant artifact contract), and Q8 (independence enforcement via requiresIndependentHarnessFrom). Parallelizable with Phases 2 and 2.5. Estimated 2 weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 HarnessAdapter interface + HarnessRequires + HarnessAvailability + HarnessCapabilities types implemented at orchestrator/src/harness/types.ts per RFC §13.1
- [ ] #2 Adapter registry at orchestrator/src/harness/registry.ts per RFC §13.2
- [ ] #3 Static capability matrix declared per RFC §13.3 with requires: { binary, versionRange, versionProbe } per RFC §13.8 (Q6)
- [ ] #4 Pipeline-load validation per RFC §13.4 + §13.8: isAvailable() runs version probe, primary failure → HarnessUnavailable pipeline-load error; fallbacks degrade with warning (Q6)
- [ ] #5 ClaudeCodeAdapter implemented as refactor of today's hardcoded path (no behavior change; existing tests must still pass)
- [ ] #6 CodexAdapter implemented driving OpenAI Codex CLI; verify end-to-end against fixture worktree
- [ ] #7 Schema additions: Stage.harness, Stage.harnessFallback, Stage.requiresIndependentHarnessFrom, Pipeline.spec.defaultHarness, Pipeline.spec.defaultHarnessFallback (RFC §6.3, §6.5)
- [ ] #8 Runtime fallback per RFC §13.5: HarnessFallback event on availability failures; falls through chain; record actual harness in runtime.json
- [ ] #9 Independence enforcement per RFC §13.10: filter chain to exclude harnesses that ran upstream named in requiresIndependentHarnessFrom; emit IndependenceViolated if effective chain empty (Q8)
- [ ] #10 Cyclic-constraint validation: pipeline-load FAILS with CyclicIndependenceConstraint if requiresIndependentHarnessFrom references downstream stage (Q8)
- [ ] #11 Schema-conformant artifact emission contract per RFC §13.9: adapter prompt includes JSON schema, validates output, retries once on failure (Q7)
- [ ] #12 Update review-critic and review-security skills to declare harness: codex + requiresIndependentHarnessFrom: [implement] per RFC §11.3 / §13.6
- [ ] #13 Integration test: end-to-end review where Claude implements and Codex critiques; verify both artifacts land + independence preserved
- [ ] #14 Adapter-authoring guide drafted at docs/operations/adapter-authoring.md for future adapters
- [ ] #15 New code reaches 80%+ patch coverage
<!-- AC:END -->
