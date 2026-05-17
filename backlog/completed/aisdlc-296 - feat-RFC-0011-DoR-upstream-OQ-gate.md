---
id: AISDLC-296
title: 'feat: RFC-0011 DoR upstream-OQ gate (reject impl tasks when referenced RFC has open OQs)'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0011
  - dor-gate
  - governance-gap
  - critical
dependencies: []
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Close the governance gap surfaced by AISDLC-269 / 270 / 271: implementation tasks were filed and dispatched against RFCs that still had unresolved OQs because the DoR gate (RFC-0011) only checks task-level clarification readiness, not upstream RFC OQ status.

## Concrete failure modes this gate prevents

- **AISDLC-269 (RFC-0024):** filed 2026-05-13 with all 12 OQs flagged as "pre-work required" in prose. First-pass walkthrough happened same day; impl shipped 2026-05-15. Second walkthrough that day revised 7/12 OQs, leaving a gap between shipped and resolved design.
- **AISDLC-270 (RFC-0025):** filed 2026-05-13 with 10 OQs unresolved. Task is correctly still in `backlog/tasks/` only because no one dispatched it. No gate would have rejected dispatch.
- **AISDLC-271 (RFC-0031):** filed 2026-05-13; OQs resolved inline by the dev subagent during implementation.

## Scope

- DoR rubric extension: tasks labeled `chore-complete-RFC-N` (or with `references:` pointing at an RFC file) MUST be rejected when:
  - the referenced RFC's `lifecycle:` is `Draft` or `Ready for Review` (not `Signed Off` or `Implemented`), OR
  - the referenced RFC's §OQ section contains any unresolved OQ (no `Resolution:` marker)
- Rejection emits a `DorRejectedByOpenUpstreamOq` event with the RFC reference + OQ count.
- Manual override available via `blocked.reason` frontmatter field with explicit operator note.
- Existing tasks in flight grandfathered (only applies to new dispatches after rollout).
- Compose with RFC-0035 Decision Catalog: each upstream OQ becomes a Decision record in the catalog (when RFC-0035 ships).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 DoR rubric checks referenced RFC's lifecycle field; rejects on `Draft` or `Ready for Review`
- [ ] #2 DoR rubric scans referenced RFC's §OQ section; rejects on any unresolved OQ
- [ ] #3 `DorRejectedByOpenUpstreamOq` event emitted with RFC ref + OQ count
- [ ] #4 Manual override via `blocked.reason` with explicit operator note
- [ ] #5 Test coverage: rejected-on-draft-RFC, rejected-on-open-OQ, accepted-on-signed-off + zero-OQ
- [ ] #6 Documented in CLAUDE.md Backlog Workflow section
<!-- AC:END -->
