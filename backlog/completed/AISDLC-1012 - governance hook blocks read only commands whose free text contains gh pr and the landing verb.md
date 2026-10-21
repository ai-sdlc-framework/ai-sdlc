---
id: AISDLC-1012
title: >-
  Governance hook blocks read-only commands whose free text contains "gh pr" and the landing verb; match the gh subcommand, not prose
status: Done
assignee: []
created_date: '2026-10-21'
labels:
  - hooks
  - velocity
  - root-cause
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - docs/operations/prompt-rules.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-21 17:30Z).** The PreToolUse hook in `enforce-blocked-actions.js` refuses any Bash command whose text contains `gh pr` together with the landing verb, wherever they appear: JSON field names such as `mergeStateStatus` or `mergedBy` in a `gh pr view --json` query, a file path such as `pipeline-cli/src/governance/merge-if-eligible.ts`, an echo string, a heredoc writing a note, or a PR body. In this repo the planner was blocked five times today on read-only commands and notes; the adopter planner six times. The same text matcher refuses a heredoc that merely mentions the lease-push spelling. Every false refusal costs a retry with reworded text, and tempts a session toward writing scripts to a file to dodge the matcher, which is worse than the thing the matcher guards.

**Five-step review (requirements first).**
1. Requirement questioned: "block any command text that mentions the forbidden phrase". The rule's purpose is to stop the raw gh landing and close subcommands, the raw git merge and the plain force push. Those are shell commands with a grammar; prose, JSON field names and paths are not commands.
2. Delete: the free-text phrase match.
3. Simplify: parse the command into shell segments (the tokenizer already used by `lease-push-guard.js`), and refuse only when a segment's executable is `gh` with positional args `pr merge` or `pr close` (or `issue close`), or `git` with `merge`, `push --force`/`-f`, `branch -D`, `reset --hard`; wrappers (`env`, `sudo`, `xargs`, `command`) are unwrapped as the lease guard already does. Quoted strings, heredoc bodies, `--jq` expressions and paths are never matched. An unparseable segment (alias, `$` expansion of the executable) fails closed as today.
4. Accelerate: zero false refusals on read-only `gh pr view`, `gh pr list`, `grep`, `echo`, `cat` heredocs and file paths.
5. Automate: a regression corpus of today's eleven false refusals and the true positives, run in the hook test suite.

**Velocity impact.** Positive: removes a retry per false refusal and the pressure to work around the hook. Guard unchanged for the real commands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A corpus test in the hook suite passes: `gh pr view 1780 --json mergeStateStatus,mergedBy`, `gh pr list --json mergeable`, `grep -n merge pipeline-cli/src/governance/merge-if-eligible.ts`, `echo "merges clean"`, and a heredoc whose body contains the lease-push spelling and the raw landing phrase are all allowed
- [ ] #2 The same corpus refuses: the raw gh landing subcommand with and without `--auto`, `gh pr close`, `gh issue close`, `git merge`, `git push --force`, `git push -f`, `git branch -D`, `git reset --hard`, each also when wrapped in `env`, `sudo`, `command` or `xargs`, and when the executable is a `$` expansion or alias (fail closed)
- [ ] #3 The blocked-command list is read from one place (`prompt-rules.js` or the existing blocked-actions table), not duplicated in the matcher
- [ ] #4 `docs/operations/prompt-rules.md` states that the hook matches shell grammar, not free text, and lists the refused subcommands
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/`
- `pnpm lint && pnpm format:check`

## Final Summary

Superseded by AISDLC-1014 (DEC-0267): the command-text matcher is deleted instead of narrowed.
