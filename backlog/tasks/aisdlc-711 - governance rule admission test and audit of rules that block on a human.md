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
  - .github/pull_request_template.md
  - ai-sdlc-plugin/hooks
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
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
- [ ] The admission test from DEC-0048 (necessity, velocity impact, agent-resolvable exit, permissive default, post-ship evidence) is written into docs/operations as the governance rule policy and referenced from CLAUDE.md in one or two lines (this task authorizes that CLAUDE.md edit) and from CONTRIBUTING.
- [ ] The pull request template, or the PR-body check the pipeline already runs, requires a "Velocity impact" section whenever a PR touches governance surfaces: `ai-sdlc-plugin/hooks/**`, the governance resolver and its schema defaults, `.ai-sdlc/agent-role.yaml` templates, required-check or ruleset configuration, and workflow gates. The check passes automatically for PRs that touch none of them, and its failure message says exactly what to add, so it never needs a human to clear it.
- [ ] Reviewer agent prompts (code, security, and the combined correctness reviewer) include the admission test: a new rule whose only exit is a human, or which fires on the documented happy path under default config, is a major finding. Security reviewers are told to propose the narrowest control and an agent-resolvable exit with any new block they ask for.
- [ ] A happy-path test runs the documented workflow command set (worktree setup, commit, rebase onto main, lease push to the own branch, PR create, draft to ready, attestation sign, arming a merge through the sanctioned command, decision add and escalate, task create under the own parent) through the governance hooks with DEFAULT configuration in a fresh fixture repository and asserts that none is denied. Adding a rule that breaks it fails CI. The command set lives in one data file so new workflows are added in one place.
- [ ] Every refusal message produced by the governance hooks names the rule, the config key and value or sanctioned command that resolves it, and never instructs the agent to ask the operator; a test enumerates the deny call sites and asserts this.
- [ ] Audit: a table in the PR (and kept in docs/operations) lists every existing governance rule and gate with: what it prevents, default, whether it can fire on the happy path, its exit, and a verdict of keep, narrow, change default, or remove. Each rule that fails the admission test is fixed in this PR when the fix is a default or a message, or gets its own follow-up task named in the table when larger. Known candidates to include: the merge-phrase text matcher that blocks greps and heredocs, the workflow-path edit block for internal tasks, the single accepted spelling of the lease push, the `ai-sdlc/issue-link` check failing on filing-only PRs, the stop-hook coverage run, and any gate that can only be cleared by an operator environment variable.
- [ ] Refusals are counted: each hook deny writes one line to the existing events log with rule id, command class and resolution path, and a `cli-status` (or doctor) view shows refusals per rule over the last 7 days so rules that block often are visible.
- [ ] The decision catalog classification gains a tag for governance-rule changes so they appear in the operator digest.

## Out of scope
- Removing review, attestation or coverage requirements.
- Granting merge rights beyond what other tasks define.
- The operator-only list (legal, money, accounts and credentials).

## Notes for the implementer
This constrains new rules and fixes defaults and messages; it does not relax a control without
the audit table saying why. Security review on opus.
<!-- SECTION:DESCRIPTION:END -->
