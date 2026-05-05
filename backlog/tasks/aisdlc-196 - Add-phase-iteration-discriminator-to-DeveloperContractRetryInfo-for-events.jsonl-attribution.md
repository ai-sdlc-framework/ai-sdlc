---
id: AISDLC-196
title: >-
  Add phase/iteration discriminator to DeveloperContractRetryInfo for
  events.jsonl attribution
status: To Do
assignee: []
created_date: '2026-05-05 00:20'
labels:
  - enhancement
  - observability
  - pipeline-cli
  - reviewer-finding
dependencies: []
references:
  - pipeline-cli/src/types.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/steps/09-iterate.ts
  - spec/schemas/orchestrator-events.v1.schema.json
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source

Reviewer follow-up from AISDLC-184 (suggestion-severity, both code-reviewer + test-reviewer flagged). The `DeveloperContractRetry` event now fires from BOTH the initial Step 5b/6 dispatch AND the Step 9 iteration loop iterations N>1, but the `DeveloperContractRetryInfo` payload (in `pipeline-cli/src/types.ts:65`) has no field that distinguishes which path emitted the event.

Operators grepping events.jsonl can count retries but cannot attribute them to:
- Initial-dispatch path (Step 5b/6) — recovery on first dev call
- Iteration-loop path (Step 9, iterations N>1) — recovery after CHANGES_REQUESTED round

The recovery-frequency story is meaningfully different on each path. Initial-path recoveries indicate dev subagent's prose-vs-JSON distribution at session start; iteration-path recoveries indicate drift under reviewer-feedback context.

## Fix

Extend `DeveloperContractRetryInfo`:

```ts
export interface DeveloperContractRetryInfo {
  taskId: string;
  initialOutputPreview: string;
  retryOutputPreview: string;
  durationMs: number;
  phase: 'initial' | 'iteration';   // NEW
  iteration?: number;               // NEW; present when phase='iteration', 2+
}
```

Update both call sites + events schema (additive, non-breaking).

Note: depends on AISDLC-184 (not yet in mcp index after merge of PR #318; declare manually).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DeveloperContractRetryInfo gains phase + iteration optional fields (additive, non-breaking)
- [ ] #2 Both call sites (execute-pipeline.ts initial-dispatch + 09-iterate.ts iteration-loop) pass the discriminator
- [ ] #3 Tests assert the values
- [ ] #4 Schema update for events.jsonl
- [ ] #5 Operator-facing example query in docs
<!-- AC:END -->
