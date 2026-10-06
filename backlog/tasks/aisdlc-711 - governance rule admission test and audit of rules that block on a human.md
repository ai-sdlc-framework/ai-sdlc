---
id: AISDLC-711
title: >-
  Governance rule admission test and audit of rules that block on a human
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - adopter
dependencies: []
references:
  - CLAUDE.md
  - CONTRIBUTING.md
  - .github/PULL_REQUEST_TEMPLATE.md
  - ai-sdlc-plugin/hooks
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Narrowed by the planner on 2026-10-04 (DEC-0056 scrutiny): happy-path test and refusal-message check only.

Governance rules have been added one reviewer finding at a time. Several stop work until a
human acts: the force-push default of never (AISDLC-663) blocked the framework's own rebase
workflow in every adopter repository; agents could not land a release PR; a hook refuses any
shell command whose text contains a merge phrase, including greps and documentation;
workflow-path edits are refused for internal tasks that authorize them; sessions waited for
the operator's direct word. Per DEC-0048 every governance rule must justify its necessity and
its effect on velocity, and none may leave work blocked on human intervention.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] A happy-path test runs the documented workflow command set (worktree setup, commit, rebase onto main, lease push to the own branch, PR create, draft to ready, attestation sign, arming a merge through the sanctioned command, decision add and escalate, task create under the own parent) through the governance hooks with DEFAULT configuration in a fresh fixture repository and asserts that none is denied. Adding a rule that breaks it fails CI. The command set lives in one data file so new workflows are added in one place.
- [ ] Every refusal message produced by the governance hooks names the rule, the config key and value or sanctioned command that resolves it, and never instructs the agent to ask the operator; a test enumerates the deny call sites and asserts this.

## Out of scope
- Removing review, attestation or coverage requirements.
- Granting merge rights beyond what other tasks define.
- The operator-only list (legal, money, accounts and credentials).

## Notes for the implementer
This constrains new rules and fixes defaults and messages; it does not relax a control without
the audit table saying why. Security review on opus.
<!-- SECTION:DESCRIPTION:END -->
