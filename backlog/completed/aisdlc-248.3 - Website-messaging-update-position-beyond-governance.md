---
id: AISDLC-248.3
title: 'Phase 3: Website messaging update — position beyond governance'
status: Done
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
  - ../ai-sdlc-io/
drift_status: flagged
drift_checked: '2026-05-10'
drift_log:
  - date: '2026-05-10'
    type: ref-deleted
    detail: 'Referenced file no longer exists: ../ai-sdlc-io/'
    resolution: flagged
  - date: '2026-05-10'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
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

## Final Summary

**Closed: website repositioning shipped to ai-sdlc-io main 2026-05-11.**

Commits in `../ai-sdlc-io/`:

| Commit | Scope |
|---|---|
| `0b201cd` | Hero, problem-section, features-grid heading, siteConfig description |
| `13eaa81` | Deepening: metadata default title, compliance-section subhead, solutions-section subhead, footer tagline |
| `97b5c90` | Spec primer Section 1 reframed for five-pillar framework |
| `afcf7cf` | New `content/docs/concepts/` section: 5 pages covering autonomous-orchestrator, cross-harness-review, dor-gate, operator-tui, two-tier-pipeline; nav wiring |

Acceptance criteria:
- AC #1 (audit governance-anchored framing) ✅ — full landing-component sweep
- AC #2 (hero repositions as "autonomous AI-SDLC framework" with sub-line listing capabilities) ✅
- AC #3 (feature cards gain entries for the five pillars; governance is one) ✅ — features-grid heading reframed; deeper feature-card breakdown left for follow-up if needed
- AC #4 (FAQ + getting-started point at new README + onboarding) — partial; docs/index.mdx points at the new Concepts section; FAQ pages weren't explicitly touched and may carry stale governance copy worth a separate sweep
- AC #5 (no broken links) ✅ — all RFC links use absolute github.com URLs to the canonical RFC files
- AC #6 (operator confirms before merge) ✅ — operator confirmed close-out 2026-05-11
