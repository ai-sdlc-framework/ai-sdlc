---
id: AISDLC-268
title: "Backlog adapter doesn't extract code-area from task References:"
status: To Do
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - ppa
  - admission
  - backlog-adapter
dependencies: []
priority: medium
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
---

## Bug

The backlog adapter that feeds the admission engine doesn't extract a code-area signal from task `references:` (or `References:` in markdown body). Forge backlog tasks list referenced files in their descriptions; the adapter could parse the most-common-path-prefix from those references and pass it as `--code-area`.

Today, every task gets the uniform `Eρ` (envelope expansion / area-of-effect) variance of 0.30, which prevents the admission engine from differentiating tasks with narrow blast radius (single-package fix) from broad ones (cross-package refactor).

## Fix

In the backlog adapter (likely `pipeline-cli/src/dor/resolvers/` or `pipeline-cli/src/admission/`):

1. Read the task's `references:` array (frontmatter) AND any `## References` section in the body.
2. Compute the most-common-path-prefix across all references. Examples:
   - All paths under `pipeline-cli/src/orchestrator/` → `code-area = pipeline-cli/orchestrator`
   - Mixed prefixes → fall back to the deepest common ancestor, OR pass multiple code-areas
3. Pass the resulting code-area(s) to admission scoring as `--code-area <prefix>`.
4. The admission engine uses code-area to compute per-task `Eρ` variance instead of the uniform 0.30.

## Acceptance criteria

- [ ] Backlog adapter parses `references:` (frontmatter + body) and emits `codeArea: <prefix>`.
- [ ] When references span multiple top-level prefixes, adapter emits the deepest common ancestor (or list).
- [ ] Admission scoring respects `codeArea` to compute per-task `Eρ` variance instead of uniform 0.30.
- [ ] Test coverage: fixture tasks with single-prefix, multi-prefix, no-references; assert correct `codeArea` extraction.
- [ ] Adopter docs explain how `references:` shapes admission scoring — encourages teams to keep references curated.

## Source

Adopter session 2026-05-13, ranked #8 by friction. Forge tasks have rich references that we're leaving on the floor.
