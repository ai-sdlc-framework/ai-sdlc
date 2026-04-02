---
id: AISDLC-8.1
title: >-
  Phase 1: Offload deterministic checks to CI — stop LLM agents from duplicating
  CI
status: Done
assignee: []
created_date: '2026-04-02 17:49'
updated_date: '2026-04-02 18:01'
labels:
  - review-agents
  - ci-cd
milestone: v0.8.0
dependencies: []
references:
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/ci.yml
  - orchestrator/src/runners/review-agent.ts
parent_task_id: AISDLC-8
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update the review agent prompts to explicitly exclude findings that CI already covers. The review workflow should pass CI status to the agents so they know what's already checked.

## What to offload
- Lint errors → ESLint CI check (already exists)
- Type errors → TypeScript build CI check (already exists)  
- Format issues → Prettier CI check (already exists)
- Test coverage → codecov/patch CI check (already exists)
- Missing tests → codecov flags missing lines

## Changes needed
1. Update `ai-sdlc-review.yml` to pass CI check results as context to review agents
2. Update review agent prompts: "CI already validates: lint, typecheck, format, coverage. Do NOT duplicate these. Focus on logic errors, security, and design."
3. Remove rules 10, 14, 18 from review-policy.md (coverage, missing tests, zero coverage claims)
4. Add CI status context to the diff passed to review agents
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Review agents never comment on lint, format, typecheck, or coverage issues
- [ ] #2 CI status (pass/fail per check) is included in the context sent to review agents
- [ ] #3 At least 3 rules removed from review-policy.md
<!-- AC:END -->
