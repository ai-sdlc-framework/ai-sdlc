---
id: AISDLC-248.3
title: 'Phase 3: Website messaging update — position beyond governance'
status: To Do
assignee: []
created_date: '2026-05-09 19:30'
labels:
  - docs
  - website
  - positioning
  - phase-3
parentTaskId: AISDLC-248
dependencies:
  - AISDLC-248.2
priority: high
permittedExternalPaths:
  - '../ai-sdlc-io/'
references:
  - ../ai-sdlc-io/
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal
Update the public website (sibling repo `../ai-sdlc-io/`) so the homepage, feature cards, and FAQ reflect the project's full positioning.

## Cross-repo writes
This task writes into the sibling website repo (`../ai-sdlc-io/`). The frontmatter declares `permittedExternalPaths: ['../ai-sdlc-io/']` so the PreToolUse hook lets the dev write there.

## Acceptance Criteria
<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Audit current website copy on `../ai-sdlc-io/` for "governance"-anchored framing (hero, features section, FAQ, blog index)
- [ ] #2 Hero section repositions the product as an "autonomous AI-SDLC framework" with the sub-line listing the major capabilities (orchestrator + cross-harness review + decision engine + TUI + adopter scaffold)
- [ ] #3 Feature cards / sections gain entries for: autonomous orchestrator, Codex + Claude cross-harness review, decision engine + DoR, operator TUI, adopter init scaffold, and (yes) governance + DSSE attestations as ONE pillar
- [ ] #4 FAQ + getting-started page point at the new README + adopter onboarding runbook
- [ ] #5 No broken links between the website and the GitHub repo (RFCs, runbooks, operator docs)
- [ ] #6 Operator confirms the new copy before merge — this task's PR should NOT auto-merge; require human review on the website PR
<!-- SECTION:ACCEPTANCE:END -->
<!-- SECTION:DESCRIPTION:END -->
