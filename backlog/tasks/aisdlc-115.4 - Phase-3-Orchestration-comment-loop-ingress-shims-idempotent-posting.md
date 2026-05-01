---
id: AISDLC-115.4
title: 'Phase 3: Orchestration + comment loop (ingress shims + idempotent posting)'
status: To Do
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-3
  - orchestration
  - comments
milestone: m-3
dependencies:
  - AISDLC-115.3
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#52-ingress-shims
  - >-
    spec/rfcs/RFC-0011-definition-of-ready-gate.md#62-comment-format-and-idempotency
parent_task_id: AISDLC-115
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wires Stage A+B verdicts into the actual issue lifecycle via two ingress shims (GitHub Action + Claude Code subagent). Per RFC §12 Phase 3 + §5.2 + §6.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GitHub Action ingress shim wired to `issues.opened` + `issues.edited` + `pull_request` events touching `backlog/tasks/*.md`
- [ ] #2 Claude Code subagent ingress shim (refinement-reviewer) invokable from `/ai-sdlc execute` when a backlog task is created in-session
- [ ] #3 Status transitions: `Draft` → `To Do` triggers DoR; failed DoR → `Needs Clarification`; author edit → re-check → admit on pass
- [ ] #4 Comment posting is idempotent (HTML marker `<!-- ai-sdlc:dor-comment -->` per RFC §6.2)
- [ ] #5 Dual-fanout per Q5: comments go to author channel AND optional dedicated channel simultaneously
- [ ] #6 Two-stage staleness per Q6: warn at 14d, auto-close at 28d (configurable via `dor-config.yaml`)
- [ ] #7 E2E test: vague issue created → DoR comment posted → author edits → re-check → admitted as ready
- [ ] #8 New code reaches 80%+ patch coverage
<!-- AC:END -->
