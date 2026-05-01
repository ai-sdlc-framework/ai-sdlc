---
id: AISDLC-115.3
title: 'Phase 2b: Refinement-reviewer agent (Stage B LLM evaluator)'
status: To Do
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-2b
  - agent
  - llm
  - review
milestone: m-3
dependencies:
  - AISDLC-115.2
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#5-the-dor-reviewer-agent
  - ai-sdlc-plugin/agents/refinement-reviewer.md
parent_task_id: AISDLC-115
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
LLM-backed Stage B evaluator: handles the gates that need semantic judgment (e.g., "is the AC actually testable?", "is the done-state describable?"). Composed with Stage A from Phase 2a — Stage A runs first, Stage B only fires for gates Stage A couldn't decide. Per RFC §12 Phase 2b.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New plugin agent at `ai-sdlc-plugin/agents/refinement-reviewer.md` with binary-yes/no prompt per Stage B gate
- [ ] #2 Structured verdict output combining Stage A + Stage B per `refinement-verdict.v1.schema.json`
- [ ] #3 Confidence tiering: high|medium|low per Q4 resolution (medium = act-but-spot-check; low = escalate)
- [ ] #4 Agent achieves ≥90% Stage B match against test corpus
- [ ] #5 End-to-end (Stage A + B) achieves ≥95% match against test corpus
- [ ] #6 Calibration log writes to `$ARTIFACTS_DIR/_dor/calibration.jsonl` per RFC §5.5
- [ ] #7 Shadow-mode eval against last 4 weeks of real issues shows <5% disagreement vs Stage-A-only baseline (validates LLM isn't introducing noise)
- [ ] #8 New code reaches 80%+ patch coverage
<!-- AC:END -->
