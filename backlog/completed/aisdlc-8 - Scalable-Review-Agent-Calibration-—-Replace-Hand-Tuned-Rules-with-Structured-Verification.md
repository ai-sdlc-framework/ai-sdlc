---
id: AISDLC-8
title: >-
  Scalable Review Agent Calibration — Replace Hand-Tuned Rules with Structured
  Verification
status: Done
assignee: []
created_date: '2026-04-02 17:49'
updated_date: '2026-04-02 20:10'
labels:
  - architecture
  - review-agents
  - calibration
  - prd
milestone: v0.8.0
dependencies: []
references:
  - orchestrator/src/analysis/
  - orchestrator/src/runners/review-agent.ts
  - .ai-sdlc/review-policy.md
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/ci.yml
  - >-
    https://venturebeat.com/orchestration/metas-new-structured-prompting-technique-makes-llms-significantly-better-at
documentation:
  - docs/prd-claude-code-native-integration.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The current review policy (`.ai-sdlc/review-policy.md`) has grown to 21+ hand-tuned rules, each added to suppress a specific false positive. This approach doesn't scale:
- Rules interact unpredictably — suppressing false positives in one area suppresses true positives in another
- The prompt gets increasingly expensive and fragile as rules accumulate
- We're encoding symptoms instead of teaching judgment
- Every new false positive requires a code change to the policy

## Vision

Replace the hand-tuned rule document with a **deterministic-first, LLM-second architecture** where:
1. **CI/CD handles everything it can** — linting, type checking, test coverage, format checks, security scanning (CodeQL/Semgrep) are deterministic and reliable. Offload as much as possible here.
2. **AST-based preprocessing** validates structural properties before the LLM sees the diff — import patterns, unused exports, function signatures, type safety. We already have AST analysis in the orchestrator.
3. **Structured reasoning templates** force review agents to trace code paths and cite evidence before classifying severity (Meta's research: 78% → 93% accuracy)
4. **Principles + exemplar bank** replace specific rules — 5-7 durable principles plus 15-20 labeled examples (true bugs, false positives, borderline cases)
5. **Confidence-gated filtering** suppresses low-confidence findings without prompt changes

The LLM review agents should focus ONLY on what deterministic tools can't do: logic errors, architectural violations, subtle security issues, and design feedback.

## Key Research

- Meta's structured prompting: forcing evidence-based reasoning improves code review accuracy from 78% to 93%
- Qodo/PR-Agent: "the model matters less than the preprocessing" — AST parsing before LLM review
- CodeRabbit: agentic validation (running tools to verify findings)
- GitHub Copilot: hybrid LLM + deterministic engines (ESLint, CodeQL)

## Architecture

```
PR Diff
  │
  ├─→ [Deterministic] CI/CD pipeline (lint, typecheck, test, coverage, security scan)
  │     └─→ Pass/fail signals (no LLM needed)
  │
  ├─→ [Deterministic] AST Preprocessor (existing orchestrator analysis)
  │     └─→ Structural findings (unused exports, missing types, import violations)
  │
  └─→ [LLM] Review Agents (only what's left)
        ├─→ Structured reasoning template (must cite evidence)
        ├─→ Principle-based constitution (5-7 rules, not 21+)
        ├─→ Exemplar bank (15-20 labeled examples)
        ├─→ Confidence scores (0-1) per finding
        └─→ Meta-review pass (medium-confidence findings only)
```

## References

- Meta structured prompting: https://venturebeat.com/orchestration/metas-new-structured-prompting-technique-makes-llms-significantly-better-at
- Existing AST analysis: `orchestrator/src/analysis/`
- Current review agents: `orchestrator/src/runners/review-agent.ts`
- Current review policy: `.ai-sdlc/review-policy.md`
- CI workflow: `.github/workflows/ci.yml`
- Review workflow: `.github/workflows/ai-sdlc-review.yml`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Review agents produce <10% false positive rate without hand-tuned rules
- [ ] #2 Review policy document is replaced by principles + exemplar bank
- [ ] #3 CI/CD handles lint, typecheck, coverage, format — review agents don't duplicate these checks
- [ ] #4 AST preprocessor filters structural issues before LLM review
- [ ] #5 Each LLM finding includes confidence score and evidence citation
- [ ] #6 Medium-confidence findings go through meta-review pass
- [ ] #7 False positive rate measurable via human accept/dismiss feedback
<!-- AC:END -->
