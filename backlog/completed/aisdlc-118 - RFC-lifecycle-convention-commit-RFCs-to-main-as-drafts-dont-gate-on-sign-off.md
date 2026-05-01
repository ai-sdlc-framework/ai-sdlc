---
id: AISDLC-118
title: >-
  RFC lifecycle convention: commit RFCs to main as drafts (don't gate on
  sign-off)
status: Done
assignee: []
created_date: '2026-05-01 16:35'
labels:
  - process
  - rfc-lifecycle
  - documentation
  - stakeholder-comms
dependencies: []
references:
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0001-template.md
  - CLAUDE.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Today RFCs live on feature branches until full sign-off, then merge to main. This means:

- **Stakeholders can't reference them**: Alex needed to read RFC-0011 v3 to sign off; if it had been on main, he could have linked to `https://github.com/.../spec/rfcs/RFC-0011-...md`. Instead, the draft lived on a branch and required dev tooling to view.
- **Drafts get lost**: RFC-0011 + RFC-0012 currently exist locally but not on main. Anyone joining the project sees an incomplete RFC index. The implementation work for those RFCs has begun (AISDLC-115, AISDLC-100.x) but the design rationale is invisible.
- **Sign-off blocks visibility, not the other way**: the current convention conflates "is this signed off?" with "should this be in the repo?" These are orthogonal questions.

## Why this matters

RFCs are signaling documents. Their value is highest when stakeholders can see them DURING design, not just after. Hiding drafts until sign-off destroys the feedback loop the RFC process is supposed to create.

## Proposed lifecycle

| Lifecycle | Meaning | Sign-off state |
|---|---|---|
| **Draft** | Initial brainstorm; structure may shift | Sign-off boxes empty |
| **Ready for Review** | Structure stable; ready for owner sign-off | At least one owner signed; awaiting others |
| **Signed Off** | All owners signed; design locked | All owner boxes checked |
| **Implemented** | Corresponding milestone reached Done | n/a (post-sign-off state) |
| **Superseded** | Replaced by newer RFC | Header notes the successor |

Drafts MUST land on main as soon as the author considers them shareable (probably after the first internal pass). Subsequent edits go through normal PR review like any other doc.

## Acceptance criteria expanded in checklist below.

## Why this is high-priority

The RFC visibility gap blocks stakeholder review (Alex example today) and creates onboarding friction. The fix is small (convention update + index + lifecycle field). Ship now so future RFCs benefit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 spec/rfcs/README.md documents the new RFC lifecycle: Draft → Ready for Review → Signed Off → Implemented → Superseded
- [ ] #2 RFC frontmatter gains a `Lifecycle:` field with the status (separate from sign-off, which stays as the per-owner checklist)
- [ ] #3 spec/rfcs/RFC-0001-template.md updated with the new Lifecycle field + brief explanation that drafts SHOULD land on main early so stakeholders can link to the canonical URL
- [ ] #4 CLAUDE.md gets a brief subsection under 'RFCs' explaining the new lifecycle (Draft = brainstorm, Ready for Review = ready for sign-off, Signed Off = all owners signed, Implemented = corresponding milestone closed, Superseded = replaced by newer RFC)
- [ ] #5 All currently-local RFCs (RFC-0011, RFC-0012) get landed on main with appropriate Lifecycle status (Signed Off for RFC-0011, Draft or Ready-for-Review for RFC-0012)
- [ ] #6 spec/rfcs/README.md index table shows Lifecycle column so stakeholders see the state at a glance
- [ ] #7 Optional Phase 2 (filed separate if needed): `pnpm rfc:check` validates Lifecycle field is present + matches sign-off state (e.g., Signed Off lifecycle requires all owners to have signed)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Formalized RFC lifecycle convention. Added lifecycle: frontmatter field (Draft|Ready for Review|Signed Off|Implemented|Superseded) + schema enum + auto-derived mirror + README index column + template + CLAUDE.md docs. Backfilled all 12 existing RFCs.

## Verification
- pnpm rfc:check OK; pnpm test 46/46 pass; build/lint/format clean
- 3 reviews APPROVED: code 0c/0M/2m/2s; test 0c/0M/1m/0s; security 0c/0M/0m/0s

## Follow-up
- pnpm rfc:check should validate lifecycle + sign-off consistency (separate task)
<!-- SECTION:FINAL_SUMMARY:END -->
