---
id: AISDLC-684
title: >-
  Enforce the RFC-0051 executor authority matrix with a PreToolUse rule, not advisory prompt text
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - security
  - hooks
  - rfc-0051
dependencies:
  - AISDLC-666
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/hierarchy-role.js
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Security review of AISDLC-666 (executor loop skill) found that every hard rule in the
executor role is advisory prompt text. From an executor-role session, `SendMessage` to
any recipient, `cli-decisions answer` and top-level `task_create` remain reachable; the
authority matrix in RFC-0051 says an executor may do none of these. Recorded as MEDIUM
(counted major) and split out of 666 by DEC-0018 because it is a new enforcement
surface, not a fix inside the skill. Filed by the planner session 2026-10-03.

The framework already has the pattern: `enforce-blocked-actions.js` is a PreToolUse
hook that blocks commands from the resolved RFC-0048 governance policy, and
`hierarchy-role.js` resolves which RFC-0051 role the current session holds from the
roster. This task joins them.

## Conventions
- Plugin hooks are plain Node ESM under `ai-sdlc-plugin/hooks/`, tested with the hook
  test harness (Linux portability: no `/dev/stdin` reads, small env).
- Fail closed only on a positive role match; a session whose role cannot be resolved is
  treated as the operator and is never blocked by this rule.
- Defaults strict; a repo relaxes through the RFC-0048 governance section.

## Scope
1. **Role-scoped rules in the governance policy:** add an optional
   `governance.roles.<role>.blockedTools` list (tool name plus optional argument
   matcher) resolved like the other RFC-0048 settings, with strict defaults for
   `executor`: block `SendMessage` to anything but the dispatch session named in the
   roster, block `cli-decisions answer|resolve|override`, block top-level `task_create`
   (sub-task filing under the executor's own task stays allowed).
2. **PreToolUse hook:** resolve the role with `hierarchy-role.js` (after AISDLC-666's
   fix: running entries only, nearest ancestor, process verified as claude), load the
   resolved policy, and deny matching tool calls with a message naming the role, the
   rule and the escalation path (ask dispatch).
3. **Render the narration from the same policy** so the executor skill's hard-rule
   text and the hook agree (RFC-0048 principle).
4. **Tests:** executor session blocked on each default rule; dispatch and planner
   sessions unaffected; unresolved role unaffected; a repo override that empties the
   list is honoured.

5. **Claim-holder check on `write-verdict`** (carried from the AISDLC-666 review,
   DEC-0021): `cli-dispatch write-verdict` skips the claim-holder check that
   `complete` now enforces. Require `--worker`, refuse when the caller does not hold
   the claim, write nothing on refusal; document it as a mistake-guard, not
   authentication.

## Acceptance Criteria
- [ ] In an executor-role session, `SendMessage` to a non-dispatch recipient, `cli-decisions answer` and top-level `task_create` are denied by the hook with a message that names the rule.
- [ ] The same calls succeed in planner and dispatch sessions and in a session with no resolvable role.
- [ ] `write-verdict` without `--worker`, or from a worker that does not hold the claim, is refused with nothing written.
- [ ] The executor skill's hard-rule text is rendered from the resolved policy; no rule string is duplicated.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
