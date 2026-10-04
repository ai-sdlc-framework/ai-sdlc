---
id: AISDLC-684
title: >-
  Enforce the RFC-0051 executor authority matrix with a PreToolUse rule, not advisory prompt text
status: Done
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
2. **PreToolUse hook:** resolve the role with `hierarchy-role.js` (as hardened by the
   executor loop task this depends on: running entries only, nearest ancestor,
   process verified as claude), load the
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

6. **Role skip for the deferred coverage Stop hook** (deferred from the Stop-hook coverage
   overload fix, DEC-0022): `deferred-coverage-check.js` exits 0 without running when the session
   holds an RFC-0051 executor or operator-dispatch role, resolved with the same
   `hierarchy-role.js` helper; the pre-push gate covers those sessions.

## Acceptance Criteria
- [x] In an executor-role session, `SendMessage` to a non-dispatch recipient, `cli-decisions answer` and top-level `task_create` are denied by the hook with a message that names the rule.
- [x] The same calls succeed in planner and dispatch sessions and in a session with no resolvable role.
- [x] `write-verdict` without `--worker`, or from a worker that does not hold the claim, is refused with nothing written.
- [x] The deferred coverage Stop hook does not run in executor-role or dispatch-role sessions and still runs in planner and unresolved-role sessions.
- [x] The executor skill's hard-rule text is rendered from the resolved policy; no rule string is duplicated.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL-SUMMARY:BEGIN -->
## Summary
The RFC-0051 executor authority matrix is now enforced by a PreToolUse hook instead of prompt text. A role-scoped policy blocks the executor's `SendMessage` to anyone but dispatch, `cli-decisions answer|resolve|override` and top-level task creation, the executor skill's narration is rendered from the same policy, `write-verdict` checks the claim holder for executor callers, and the deferred coverage Stop hook skips executor and dispatch sessions.

## Changes
- `ai-sdlc-plugin/hooks/lib/role-tool-policy.js` (new): policy resolution, strict executor defaults, matchers, narration and refusal text.
- `ai-sdlc-plugin/hooks/enforce-role-tools.js` and `.sh` (new), `plugin.json` files (modified): the PreToolUse hook; it spawns nothing when no roster exists.
- `ai-sdlc-plugin/scripts/render-role-tool-rules.mjs` (new), `commands/executor.md` (modified): narration rendered from the effective policy.
- `ai-sdlc-plugin/hooks/lib/hierarchy-role.js` (modified), `pipeline-cli/src/hierarchy/session-role.ts` (new): role resolution for the CLI, kept in lockstep with the hook library by a test.
- `pipeline-cli/src/cli/dispatch.ts`, `dispatch/complete.ts` (modified): claim-holder check on `write-verdict` for executor callers.
- `ai-sdlc-plugin/hooks/deferred-coverage-check.js` (modified): role skip.
- `spec/schemas/agent-role.schema.json`, `generated-schemas.ts`, docs (modified).

## Design decisions
- **Fail closed only on a positive executor match**: no roster or an unresolved role is treated as the operator and never blocked; once the role resolves to executor, any policy error applies the strict defaults.
- **A non-empty `blockedTools` list replaces the role's defaults**, `[]` disables the role's tool blocks, and a malformed list falls back to the defaults.
- **The mention-refusal is a mistake guard, not a sandbox.**

## Verification
- hook, render, hierarchy, deferred-coverage, executor and session-start node tests pass; pipeline-cli dispatch and hierarchy tests pass (426); build, schema validation and `pnpm dark-code:check` clean.
- Hook dry run with real PreToolUse JSON for executor, planner, dispatch and no-role sessions.

## Follow-up
(none)
<!-- SECTION:FINAL-SUMMARY:END -->
