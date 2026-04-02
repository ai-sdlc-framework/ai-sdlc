---
id: AISDLC-8.4
title: 'Phase 4: Replace rule document with principles + exemplar bank'
status: Done
assignee: []
created_date: '2026-04-02 17:50'
updated_date: '2026-04-02 19:51'
labels:
  - review-agents
  - calibration
milestone: v0.8.0
dependencies:
  - AISDLC-8.3
references:
  - .ai-sdlc/review-policy.md
  - orchestrator/src/runners/review-agent.ts
parent_task_id: AISDLC-8
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the 21+ hand-tuned rules in `.ai-sdlc/review-policy.md` with a small set of durable principles and a curated bank of labeled examples.

## Principles (5-7 total)

1. **Evidence-first**: Only report findings where you can trace the code path to a concrete failure
2. **Deterministic-first**: If a linter, type checker, or CI check can catch it, don't report it
3. **Severity honesty**: If you cannot describe who is affected and how, it's not critical or major
4. **Context awareness**: Read the surrounding code and project conventions before flagging patterns as wrong
5. **Trust boundaries**: Only flag security issues at actual trust boundaries (user input, external APIs), not internal code paths
6. **Signal over noise**: One high-quality finding is worth more than ten low-quality ones
7. **Reviewer humility**: When unsure, approve with a suggestion rather than requesting changes

## Exemplar bank (15-20 examples)

Stored as `.ai-sdlc/review-exemplars.yaml`:
```yaml
exemplars:
  - id: true-bug-null-pointer
    type: true-positive
    category: logic-error
    diff: |
      +  const result = data.match(/pattern/);
      +  return result.groups.name;
    verdict: "critical — result can be null, causing TypeError"
    
  - id: false-positive-json-parse
    type: false-positive  
    category: security
    diff: |
      +  const config = JSON.parse(readFileSync('.ai-sdlc/config.yaml'));
    verdict: "not a vulnerability — file is trusted project config, not user input"
```

## Changes needed
1. Create `.ai-sdlc/review-principles.md` with the 5-7 principles
2. Create `.ai-sdlc/review-exemplars.yaml` with 15-20 labeled examples
3. Update review agent prompts to load principles + exemplars instead of rule document
4. Delete or archive the old `review-policy.md` rules (keep the golden rule and false-positive categories as exemplars)
5. When a new false positive is encountered, add an exemplar — not a rule
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 review-policy.md rules replaced by principles document (<50 lines)
- [ ] #2 Exemplar bank has 15+ labeled examples covering true bugs, false positives, and borderline cases
- [ ] #3 Review agents load principles + exemplars instead of rule document
- [ ] #4 Adding a new calibration example requires only a YAML edit, not a code change
<!-- AC:END -->
