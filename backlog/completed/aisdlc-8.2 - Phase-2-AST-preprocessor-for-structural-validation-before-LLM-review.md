---
id: AISDLC-8.2
title: 'Phase 2: AST preprocessor for structural validation before LLM review'
status: Done
assignee: []
created_date: '2026-04-02 17:49'
updated_date: '2026-04-02 19:34'
labels:
  - review-agents
  - ast
  - analysis
milestone: v0.8.0
dependencies:
  - AISDLC-8.1
references:
  - orchestrator/src/analysis/analyzer.ts
  - orchestrator/src/analysis/context-builder.ts
  - orchestrator/src/analysis/types.ts
parent_task_id: AISDLC-8
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Leverage the existing AST analysis in `orchestrator/src/analysis/` to validate structural properties of changed files BEFORE the LLM review agents see the diff. Structural issues that can be detected deterministically should be reported as deterministic findings, not LLM opinions.

## AST checks to implement
- **Unused exports**: Files export symbols not imported anywhere in the codebase
- **Import violations**: Importing from internal modules that violate package boundaries
- **Missing type annotations**: Public functions without return types (TypeScript strict)
- **Function complexity**: Cyclomatic complexity above threshold
- **File length**: Files exceeding configured line limit

## Existing infrastructure
- `orchestrator/src/analysis/analyzer.ts` — codebase analysis engine
- `orchestrator/src/analysis/context-builder.ts` — builds context from analysis
- `orchestrator/src/analysis/types.ts` — CodebaseProfile, Hotspot, etc.

## Changes needed
1. Add a `DiffAnalyzer` that runs AST analysis only on changed files
2. Integrate into the review workflow: run AST checks before spawning LLM agents
3. Pass AST findings to the review agents as "already verified" context
4. LLM agents skip re-analyzing anything the AST preprocessor already covered
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DiffAnalyzer produces deterministic findings for changed files
- [ ] #2 AST findings are passed to review agents as pre-verified context
- [ ] #3 At least 3 structural checks implemented (unused exports, import violations, complexity)
<!-- AC:END -->
