---
id: AISDLC-8.3
title: 'Phase 3: Structured reasoning templates with evidence requirements'
status: Done
assignee: []
created_date: '2026-04-02 17:50'
updated_date: '2026-04-02 19:44'
labels:
  - review-agents
  - structured-prompting
milestone: v0.8.0
dependencies:
  - AISDLC-8.1
references:
  - orchestrator/src/runners/review-agent.ts
  - >-
    https://venturebeat.com/orchestration/metas-new-structured-prompting-technique-makes-llms-significantly-better-at
parent_task_id: AISDLC-8
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace free-form review prompts with structured reasoning templates that force agents to trace code paths and cite evidence before classifying severity. Based on Meta's research showing 78% → 93% accuracy improvement.

## Structured output schema

Each finding must include:
```json
{
  "severity": "critical|major|minor|suggestion",
  "confidence": 0.0-1.0,
  "file": "path/to/file.ts",
  "line": 42,
  "category": "logic-error|security|design|performance",
  "evidence": {
    "codePathTraced": "Function X calls Y which returns null when Z, but line 42 assumes non-null",
    "failureScenario": "When input is empty string, the regex match returns null, causing TypeError on line 45",
    "affectedUsers": "All users who submit empty forms"
  },
  "message": "Null pointer: regex match result used without null check"
}
```

## Key rules
- **No evidence = no finding.** Agents cannot say "this looks wrong" without tracing the code path
- **Failure scenario required for critical/major.** Must describe the concrete failure
- **Confidence score mandatory.** Self-assessed 0-1 score

## Changes needed
1. Define the structured output JSON schema in `orchestrator/src/runners/review-schema.ts`
2. Update `REVIEW_PROMPTS` in `review-agent.ts` to use structured reasoning templates
3. Update the review workflow's verdict parser to handle confidence scores
4. Filter findings: >0.8 → post directly, 0.5-0.8 → meta-review, <0.5 → suppress
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All findings include confidence score (0-1) and evidence object
- [ ] #2 Critical/major findings require a concrete failure scenario
- [ ] #3 Findings below 0.5 confidence are automatically suppressed
- [ ] #4 Structured JSON schema validated before posting to PR
<!-- AC:END -->
