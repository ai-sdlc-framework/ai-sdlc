---
id: AISDLC-248.2
title: 'Phase 2: Documentation refresh — README + CLAUDE.md + docs/operations'
status: In Progress
assignee: []
created_date: '2026-05-09 21:30'
labels:
  - docs
  - phase-2
  - positioning
parentTaskId: AISDLC-248
dependencies: []
priority: high
references:
  - README.md
  - CLAUDE.md
  - docs/operations/
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal

Rewrite the project's primary docs surface so it positions ai-sdlc as a full autonomous AI-SDLC framework, not just a governance plugin. Operator stated 2026-05-09: "We have significantly modified this project. it's no longer just about governance we will have to reflect that change in the website messaging as well as the documentation."

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 README.md hero section + first 3 paragraphs accurately describe the project's full scope (orchestrator + cross-harness review + decision engine + TUI + adopter framework + governance — not "just governance")
- [ ] #2 README's "What is this?" or equivalent section lists the SHIPPED capabilities with anchors to the relevant RFCs (0010, 0012, 0015, 0023) and operator runbooks (`docs/operations/*.md`)
- [ ] #3 README's "Getting started" walks through the canonical adopter flow: install plugin → `/ai-sdlc init` → first dispatch → first cross-harness review (call out AISDLC-245 family is the in-flight pillar if not yet shipped)
- [ ] #4 CLAUDE.md (the project root one, not the plugin's) is reviewed for stale guidance — anything that referenced "governance only" gets rewritten
- [ ] #5 `docs/operations/` index (or sidebar) reflects all shipped runbooks (orchestrator, cross-harness, late-rebase recovery, etc.) with a navigation map
- [ ] #6 Archive or clearly mark obsolete documentation (early-RFC drafts that have been superseded) so adopters don't confuse them with current behavior
- [ ] #7 Drift gate passes (every doc reference resolves)
<!-- SECTION:ACCEPTANCE:END -->
<!-- SECTION:DESCRIPTION:END -->
