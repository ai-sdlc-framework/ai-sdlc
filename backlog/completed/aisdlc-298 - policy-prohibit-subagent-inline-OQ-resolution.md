---
id: AISDLC-298
title: 'policy: prohibit subagent-inline OQ resolution + add reviewer check'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - policy
  - subagent-governance
  - reviewer-gate
  - critical
dependencies: []
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - ai-sdlc-plugin/agents/
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Codify the prohibition on dev subagents resolving RFC OQs inline during implementation. AISDLC-271 / RFC-0031 shipped with all 5 OQs resolved by the dev subagent during one development iteration — framework-level architectural decisions decided without operator walkthrough or cross-pillar review.

## Why this is unsafe

- OQs are framework-level decisions. The "operator-as-decision-steward" principle (VISION.md, RFC-0035) means decisions belong to the operator, not the implementer.
- Subagent-decided OQs leave no audit trail of who/when/confidence/counter-argument — exactly the gap RFC-0035 Decision Catalog is built to close.
- Operator may disagree with the subagent's resolution and be forced to revert (the user's pause on PR #481 + concern about reverting AISDLC-269/271 illustrates this).

## Scope

### Policy text

Add to CLAUDE.md (Backlog Workflow + Subagent Governance section):

> **Subagents MUST NOT resolve RFC §OQ entries during implementation.** OQs require an operator walkthrough — file a separate decision walkthrough task before the implementation task is dispatched. If the subagent encounters an unresolved OQ during implementation, it MUST escalate to the operator (block the task with `blocked.reason` pointing at the OQ) rather than decide inline.

### Reviewer gate

- `code-reviewer` subagent prompt updated: detect any RFC `Resolution:` markers added in the PR diff that didn't exist on base; flag as critical issue.
- `test-reviewer` subagent prompt updated: detect tests that codify a Resolution that wasn't in the operator-decision-log; flag as critical issue.
- Both gates produce blocking (REQUEST_CHANGES) verdicts when triggered.

### Subagent prompt updates

- `developer` subagent prompt updated: explicit instruction to escalate unresolved OQs via `blocked.reason` rather than deciding.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 CLAUDE.md Subagent Governance section codifies the OQ-resolution prohibition
- [ ] #2 `code-reviewer` subagent flags new `Resolution:` markers in PR diff as critical
- [ ] #3 `test-reviewer` subagent flags tests codifying un-walked-through resolutions as critical
- [ ] #4 `developer` subagent prompt includes explicit OQ-escalation instruction
- [ ] #5 Test fixture: a synthetic PR that adds a Resolution marker triggers the reviewer gate
- [ ] #6 Documentation cross-references RFC-0035 Decision Catalog as the long-term replacement
<!-- AC:END -->
