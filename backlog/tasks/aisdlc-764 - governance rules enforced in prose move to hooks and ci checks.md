---
id: AISDLC-764
title: >-
  Governance rules enforced in prose move to hooks and ci checks
status: To Do
assignee: []
created_date: '2026-10-08'
labels:
  - governance
  - hooks
dependencies: []
references:
  - ai-sdlc-plugin/hooks/
  - scripts/check-rfc-docs.mjs
  - scripts/check-orchestrator-state.sh
  - scripts/check-changelog-edit.sh
  - CLAUDE.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The audit lists rules enforced only by prose or reviewer judgement. No control is removed here; enforcement moves into code. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. OQ-resolution marker scan in check-rfc-docs.mjs: fail when a diff adds a Resolution marker inside an Open Questions section outside a planner-authored PR.
2. Scope-creep diff check: a review or audit task plus a new backlog/tasks file fails.
3. Parent-on-main as a SessionStart hook plus a PreToolUse deny for Edit/Write and `git checkout -b` in the parent path.
4. CHANGELOG edit on a non-release branch becomes a CI failure.
5. check-sender and check-repo run inside the executor-start wrapper (AISDLC-759) so they cannot be skipped.
6. The three-reviewer rule is enforced by the pr-ready rollup for code PRs.

Sequencing: none. Velocity impact (DEC-0048): these changes remove prose from every session rather than add steps; each check is deterministic code that runs without LLM calls. Related: AISDLC-759.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: A diff adding a Resolution marker in Open Questions outside a planner PR fails check-rfc-docs.
- [ ] AC-2: A review or audit task PR that adds a backlog/tasks file fails the scope-creep check.
- [ ] AC-3: The parent-on-main hook and the PreToolUse deny exist with tests.
- [ ] AC-4: A CHANGELOG edit on a non-release branch fails CI.
- [ ] AC-5: check-sender and check-repo run inside executor-start.
- [ ] AC-6: pr-ready fails a code PR lacking the three reviewer verdicts.
<!-- AC:END -->
