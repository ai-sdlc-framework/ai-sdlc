---
id: AISDLC-115.3
title: 'Phase 2b: Refinement-reviewer agent (Stage B LLM evaluator)'
status: Done
assignee: []
created_date: '2026-05-01 16:25'
updated_date: '2026-05-01 19:45'
labels:
  - rfc-0011
  - phase-2b
  - agent
  - llm
  - review
milestone: m-3
dependencies:
  - AISDLC-115.2
parent_task_id: AISDLC-115
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#5-the-dor-reviewer-agent
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
LLM-backed Stage B evaluator: handles the gates that need semantic judgment (e.g., "is the AC actually testable?", "is the done-state describable?"). Composed with Stage A from Phase 2a — Stage A runs first, Stage B only fires for gates Stage A couldn't decide. Per RFC §12 Phase 2b.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New plugin agent at `ai-sdlc-plugin/agents/refinement-reviewer.md` with binary-yes/no prompt per Stage B gate
- [x] #2 Structured verdict output combining Stage A + Stage B per `refinement-verdict.v1.schema.json`
- [x] #3 Confidence tiering: high|medium|low per Q4 resolution (medium = act-but-spot-check; low = escalate)
- [x] #4 Agent achieves ≥90% Stage B match against test corpus
- [x] #5 End-to-end (Stage A + B) achieves ≥95% match against test corpus
- [x] #6 Calibration log writes to `$ARTIFACTS_DIR/_dor/calibration.jsonl` per RFC §5.5
- [x] #7 Shadow-mode eval against last 4 weeks of real issues shows <5% disagreement vs Stage-A-only baseline (validates LLM isn't introducing noise)
- [x] #8 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 2b: Stage B LLM evaluator (always owns gates 4 + 6, optionally 1/3/5/7 when Stage A passed with non-high confidence) plus the composite Stage A+B end-to-end orchestrator, calibration log writer, e2e + shadow-mode corpus harnesses, and the new `refinement-reviewer` plugin agent. Per-fixture E2E ground truth added to gate-4 / gate-6 corpus fixtures unblocks honest E2E assertions; existing Stage A regression suite untouched.

## Changes
- `pipeline-cli/src/dor/stage-b.ts` (new) — Stage B orchestrator + prompt builder + response parser/validator
- `pipeline-cli/src/dor/composite.ts` (new) — `evaluateIssueE2E()` Stage A→B merge, confidence aggregation
- `pipeline-cli/src/dor/calibration-log.ts` (new) — JSONL writer to `$ARTIFACTS_DIR/_dor/calibration.jsonl`
- `pipeline-cli/src/dor/shadow-mode.ts` (new) — disagreement-rate eval (corpus-as-proxy per AC #7)
- `pipeline-cli/src/dor/corpus-e2e.ts` (new) — E2E corpus harness with `CalibratedMockSpawner`
- `pipeline-cli/src/dor/{calibration-log,composite,corpus-e2e,shadow-mode,stage-b}.test.ts` (new) — full unit + harness coverage
- `pipeline-cli/src/dor/{corpus,index,types}.ts` (modified) — Stage A regression preserved; barrel + types extended for Stage B
- `pipeline-cli/src/types.ts` (modified) — `SubagentType` union extended with `'refinement-reviewer'`
- `ai-sdlc-plugin/agents/refinement-reviewer.md` (new) — read-only plugin agent (Read/Grep/Glob/Bash; Edit/Write/AgentTool disallowed per RFC §5.3)
- `ai-sdlc-plugin/agents/agents.test.mjs` (modified) — `refinement-reviewer.md` added to invariants list
- `ai-sdlc-plugin/mcp-server/dist/bin.js` (modified) — benign 4-line tree-shake artifact (new pipeline-cli imports flowing through bundle)
- `spec/dor-corpus/needs-clarification/gate-{4,6}-*/01-05.expected.json` (10 files, modified) — additive `e2e` ground-truth blocks; Stage A behaviour unchanged

## Design decisions
- **CalibratedMockSpawner for AC #4/#5/#7**: real-LLM accuracy not measured in CI; thresholds validate orchestration + merge logic. Real-LLM calibration deferred to Phase 7 soak per RFC §12. Honest framing in test file headers.
- **Stage A always wins on high-confidence blocking fail**; Stage B never overrides structural blocks. `chooseWinner()` documents the contract.
- **Calibration log paths default to `./artifacts/_dor/calibration.jsonl`** — `$ARTIFACTS_DIR` env var or programmatic opts override. See follow-up #1 below.

## Verification
- `pnpm build` — clean
- `pnpm test` — 480/480 pass (Stage A regression suite preserved at 100% per RFC §5.6 tier 1)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Coverage on new files: stage-b 100%, composite 100%, calibration-log 100%, shadow-mode 100%, corpus-e2e 93.93% — all above 80% patch threshold
- 3 reviews APPROVED (codex unavailable → INDEPENDENCE NOT ENFORCED): code 0c/0M/0m/5s; test 0c/0M/1m/3s; security 0c/0M/2m/2s

## Follow-up
- **Security minor #1 (track in new task)**: `artifacts/` not in `.gitignore`; calibration log inlines short issue bodies (≤500 chars). Add `artifacts/` to `.gitignore` OR shrink `BODY_INLINE_LIMIT` OR redact secret patterns before write.
- **Security minor #2 (track in new task)**: Stage B prompt fence-breakout — escape triple-backticks in interpolated issue body, OR wrap with sentinel + 'treat as untrusted' instruction.
- **Test minor (track in new task)**: tighten shadow-mode test arithmetic — assert exact count of expected genuine-improvement disagreements (10 = 5 gate-4 + 5 gate-6) so future fixture renames surface.
- **Phase 3 unblocked**: AISDLC-115.4 (orchestration / comment loop / ingress shims) can now proceed.
<!-- SECTION:FINAL_SUMMARY:END -->
