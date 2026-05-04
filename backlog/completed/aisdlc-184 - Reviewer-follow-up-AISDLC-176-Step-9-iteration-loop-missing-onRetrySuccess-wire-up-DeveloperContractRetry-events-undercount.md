---
id: AISDLC-184
title: >-
  Reviewer follow-up: AISDLC-176 Step 9 iteration loop missing onRetrySuccess
  wire-up (DeveloperContractRetry events undercount)
status: Done
assignee: []
created_date: '2026-05-04 18:35'
labels:
  - bug
  - orchestrator
  - observability
  - reviewer-finding
dependencies: []
references:
  - pipeline-cli/src/steps/09-iterate.ts
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - >-
    backlog/completed/aisdlc-176 -
    Orchestrator-enforce-developer-subagent-JSON-return-contract-retry-once-on-parse-failure.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source
Code reviewer on PR #251 (AISDLC-176, retro review 2026-05-04) flagged Step 9 iteration loop is missing the `onRetrySuccess` callback that Step 5b/6 has.

## Failure mode
When the dev subagent returns prose on iteration N>1 and the retry helper recovers the dispatch, no `DeveloperContractRetry` event is emitted to events.jsonl. Operators grepping recovery frequency see only initial-dispatch retries — undercounts drift on the iteration path.

Concrete scenario: dev returns prose on iteration 2, retry helper recovers, run completes 'approved', events.jsonl contains zero `DeveloperContractRetry` entries despite an actual recovery happening.

## Fix
Thread an optional `onDeveloperContractRetry` callback through `IterateReviewLoopOptions`, mirror the executePipeline wire-up so iteration-path retries emit the same event.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/steps/09-iterate.ts wires `onRetrySuccess` callback through `IterateReviewLoopOptions`
- [ ] #2 Test: dev subagent returns prose on iteration N>1, retry recovers, `DeveloperContractRetry` event IS emitted (currently zero events)
- [ ] #3 Existing iteration-success tests still pass (no regression)
- [ ] #4 events.jsonl event count for retry recovery matches across initial-dispatch path AND iteration path
<!-- AC:END -->
