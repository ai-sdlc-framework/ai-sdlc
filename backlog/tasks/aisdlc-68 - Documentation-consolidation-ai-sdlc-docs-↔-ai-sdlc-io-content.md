---
id: AISDLC-68
title: 'Documentation consolidation: ai-sdlc/docs ↔ ai-sdlc-io/content'
status: To Do
assignee: []
created_date: '2026-04-26 19:20'
labels:
  - docs
  - infrastructure
  - tech-debt
dependencies: []
references:
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/docs/
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc-io/content/
  - >-
    /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two parallel documentation trees exist with overlapping content and divergence risk:

- `/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/docs/` — source `.md` files (architecture, getting-started, tutorials, troubleshooting, api-reference, examples)
- `/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc-io/content/docs/` and `/content/spec/` — published `.mdx` files served by the Next.js site

The trees mirror each other structurally but use different formats (md vs mdx) and there is no automated sync. RFC-0006 was published without source-tree documentation, surfacing the drift risk.

Two possible architectures to evaluate:

1. **Single source of truth + build-time conversion.** ai-sdlc/docs is canonical; CI converts md → mdx and copies to ai-sdlc-io at publish time. Editors only edit one tree.
2. **Single tree, format-agnostic.** Move all docs into ai-sdlc-io/content; ai-sdlc/docs becomes a deprecation marker pointing at the canonical location. The Next.js site reads md/mdx interchangeably.

Recommendation: option 1 because it keeps the source tree colocated with the code it documents (developer ergonomics) while the published tree stays consumer-ready. The build-time conversion is a few hundred lines of script.

Out of scope for this task: writing missing docs (separate efforts per RFC). Scope is the consolidation mechanism + migration of existing content.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Decision document recorded under backlog/decisions explaining chosen architecture and rejected alternatives
- [ ] #2 Single source-of-truth location chosen and documented in both trees' README files
- [ ] #3 Conversion script (md → mdx) implemented and run against current ai-sdlc/docs content
- [ ] #4 ai-sdlc-io/content regenerated from source tree, diff reviewed, committed
- [ ] #5 CI check added that fails the build if the two trees diverge (source has content the published tree lacks, or vice versa)
- [ ] #6 Operator runbook (docs/operations/operator-runbook.md) verified to publish correctly through the new mechanism
<!-- AC:END -->
