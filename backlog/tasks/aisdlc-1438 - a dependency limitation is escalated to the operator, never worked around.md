---
id: AISDLC-1438
title: "A dependency limitation (rate limit, API quota, platform limit) is escalated to the operator, never worked around"
status: To Do
priority: high
labels:
  - governance
  - prompt-rules
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - docs/operations/prompt-rules.md
  - docs/operations/decision-authority.md
  - docs/operations/tooling-limitations.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator direction 2026-11-26. The cli-file 15-minute filing spacing (AISDLC-986) was an agent-invented workaround for a GitHub API quota: no decision record, wrong token read, ~15 minutes lost per filing for five weeks, deleted by operator ruling (AISDLC-1437). Operator: limitations of the technology we depend on (rate limits, API limits, platform limits of GitHub, npm, Actions, the Claude Code harness, etc.) are escalated to the operator, who finds the proper solution, and the escalation record is the evidence base for larger decisions (such as replacing a dependency). Nothing today stops a session from shipping a throttle, sleep, spacing, retry loop or reduced-function mode against an external limit without asking.
2. Delete: nothing.
3. Simplify: one prompt rule plus one decision-authority line; no new command. Route through the existing `cli-decisions escalate` (task sessions) or `cli-decisions add` (planner) with `--scope dependency-limit:<dependency>`, so every hit lands in the Decision Catalog and can be listed with `cli-decisions list` filtered on that scope.
4. Accelerate: none.
5. Automate: the prompt rule renders into every prompt that already renders the governance rules (grep `prompt-rules:begin`), including developer and reviewer prompts, so reviewers flag a violation.

## Acceptance Criteria
- [ ] #1 `prompt-rules.js` gains a rule `dependency-limit` with text to this effect: "**Dependency limits go to the operator:** when a rate limit, API quota or other limit of a dependency (GitHub, Actions, npm, the Claude Code harness) blocks or slows work, escalate it (`cli-decisions escalate`/`add --scope dependency-limit:<dependency>`) with the error, when it was hit, the call volume behind it and the options; never ship a throttle, sleep, spacing, cap or degraded mode against it without an operator decision record; a reviewer flags such a change as critical." It is rendered, one line, wherever the existing governance rules render; the prompt-rules render test is updated.
- [ ] #2 `docs/operations/decision-authority.md` lists dependency-limit workarounds as operator-routed (class (c)-routed: the planner may not decide them under class (a)/(b)), citing the operator decision record for this rule.
- [ ] #3 `docs/operations/tooling-limitations.md` states at the top that each row must cite the decision record that chose its workaround, and that new rows come from a `dependency-limit:` escalation.
- [ ] #4 `cli-decisions list` can filter by scope prefix `dependency-limit:` (add the filter if it does not exist) so the operator can see every escalation in one list.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass; the CLAUDE.md size test still passes (no CLAUDE.md prose added; the rule lives in prompt-rules).
