---
id: AISDLC-1014
title: >-
  Delete the command-text matcher from the blocked-actions hook; branch protection, pr-ready and cli-merge-if-eligible are the controls
status: Done
assignee: []
created_date: '2026-10-21'
labels:
  - hooks
  - velocity
  - governance
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.sh
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - docs/operations/prompt-rules.md
  - docs/operations/agent-governance-reference.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator decision, 2026-10-21 18:50Z, DEC-0267).** The PreToolUse hook `enforce-blocked-actions.js` refuses any Bash command whose text contains one of the blocked-action phrases (the raw gh landing and close subcommands, the git merge subcommand, the plain force push, the hard reset, the capital-D branch delete, the bare stash drop). The match is on free text, so it fires on JSON field names, file paths, echo strings, heredoc bodies and handoff notes. In this repo it produced nine false refusals today, including a read-only git ancestor query and the heredoc that wrote this very task; the adopter planner reported six. AISDLC-1012 proposed narrowing the match to shell grammar. The operator re-evaluated the requirement itself and chose to delete the text matcher: the controls that actually hold are branch protection on `main` (no direct push, no force push, required `ai-sdlc/pr-ready`), the pr-ready rollup, and `cli-merge-if-eligible`, which enforce policy on the server side with or without a local text guard. The prompt rule stays as instruction, rendered from `prompt-rules.js`.

**Scope.** Remove the blocked-action command-text matching (the `blockedActions` patterns listed in the session hard rules) from the hook and its wiring. Keep what is not a text match: the `blockedPaths` check for untrusted runs and the lease-push guard (`lib/lease-push-guard.js`, its own tokenizer, AISDLC-1005 mode `lease`). If after removal the hook file has no remaining responsibility, delete the file and its entries in `plugin.json` and `.claude/settings.json`; otherwise leave the path checks in place under the same name.

**Five-step review (requirements first).**
1. Requirement questioned: "a local hook must refuse the raw landing, close and force-push commands". The outcome the rule protects (nothing lands on main outside the sanctioned path) is enforced by GitHub branch protection and the rollup, which an agent cannot bypass from a shell. The local text guard adds no enforcement, only false refusals.
2. Delete: the command-text matcher and its blocked-actions table; AISDLC-1012 (archive as superseded by this task).
3. Simplify: one source for the rule, the rendered prompt line in `prompt-rules.js`; one enforcement point, the server side.
4. Accelerate: zero refusals on read-only commands, notes and paths; no reworded retries.
5. Automate: nothing new. The remaining hook tests (paths, lease push) keep running under `node --test`.

**Velocity impact.** Positive: removes every false refusal of the matcher and the pressure to script around it. Governance change: a weakening (DEC-0267, operator-answered), compensated by the server-side controls named above.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 A Bash command whose text contains any blocked-action phrase inside a `--jq` expression, a path, an echo string or a heredoc body is not refused by any PreToolUse hook (regression corpus from today's false refusals in the hook test suite)
- [x] #2 The `blockedPaths` refusal for untrusted runs and the lease-push guard behave exactly as before (`enforce-lease-push.test.mjs`, `enforce-lease-any-branch.test.mjs` and the path tests unchanged and green)
- [x] #3 The session hard rules rendered at SessionStart no longer present "Blocked actions (NEVER execute)" as hook-enforced; the prompt line in `prompt-rules.js` names the sanctioned paths and names branch protection and `cli-merge-if-eligible` as the controls
- [x] #4 `docs/operations/prompt-rules.md` and `agent-governance-reference.md` describe the controls as server-side; no doc claims the hook blocks the raw commands
- [x] #5 AISDLC-1012 is moved to `backlog/completed/` as superseded by AISDLC-1014 in the same PR
- [x] #6 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`

## Final Summary

Deleted the command-text matcher from enforce-blocked-actions.js; kept blockedPaths for untrusted runs and the lease-push guard. Session and subagent hooks no longer render a blocked-actions line; prompt rules name branch protection and the cli-merge-if-eligible helper as the controls. AISDLC-1012 closed as superseded.
