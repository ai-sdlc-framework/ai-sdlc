---
id: AISDLC-611
title: Propagate the no-bare-stash rule to developer/reviewer subagents (data-loss guard)
status: To Do
priority: high
labels:
  - safety
  - subagents
  - data-loss
created: 2026-09-14
---

## Context

Surfaced by an external adopter (local-trades), HIGH-3 of the LT-595 report and a
REAL data-loss incident: the LT-592 developer subagent ran a bare `git stash`
then `git stash pop` to isolate a test failure. Its own stash captured nothing,
so the `pop` applied+dropped a PRE-EXISTING operator stash from the shared stash
stack (a 2026-09-11 `agent-role.yaml` + task edit). It was only recovered via
`git stash store` from the dangling commit.

The git stash stack is shared across the main checkout and all worktrees (and
concurrent sessions). The operator environment already documents a "never use
bare `git stash` / `git stash pop`" rule (prefer a temp WIP commit; if you must
stash, use `git stash push -u -m "<unique-tag>"` + apply-by-sha + drop-by-tag).
That rule is NOT propagated to developer/reviewer subagents, so a subagent can
silently destroy an operator's or a sibling session's stashed work.

## Scope

Propagate the no-bare-stash rule to subagents via BOTH belt and suspenders:

1. **Agent prompt/definitions:** add the rule as a hard constraint in the
   `developer` (and `code-reviewer` / `test-reviewer` where they run git) agent
   definitions — never `git stash` / `git stash pop` without a unique `-m` tag;
   prefer a temporary WIP commit to set work aside; restore by SHA, drop by tag.
2. **PreToolUse guard (authoritative):** a Bash PreToolUse hook that BLOCKS a
   command invoking bare `git stash` (push with no `-m` tag) or `git stash pop`,
   with a message pointing at the safe pattern (temp WIP commit, or
   `git stash push -u -m <tag>` + `git stash apply <sha>` + tagged drop). The
   hook is the real enforcement (prompts are advisory); it must match the
   command robustly (segment splitting, quote-aware) without over-blocking
   legitimate tagged stashes or unrelated commands mentioning the word "stash".

## Acceptance Criteria

- [ ] AC-1: A PreToolUse Bash guard BLOCKS bare `git stash`, `git stash save`
      (no tag), and `git stash pop`; ALLOWS `git stash push -u -m "<tag>"` and
      `git stash apply <sha>` / tagged `git stash drop`. Hermetic tests cover
      block + allow cases and evasion shapes (chained `&&`, quoting).
- [ ] AC-2: The `developer` agent definition (and any reviewer that runs git)
      states the no-bare-stash rule as a hard constraint with the safe pattern.
- [ ] AC-3: The guard does not over-block: commands that merely contain the
      substring "stash" in an unrelated context (e.g. a path, an echo/heredoc,
      `git stash list`) are NOT blocked.
- [ ] AC-4: `pnpm build && test && lint` clean; the hook has `node --test`
      coverage in the plugin hooks test suite (runs on Linux CI — mind
      portability).

## References

Adopter report local-trades LT-595 (HIGH-3). Operator environment rule: prefer a
temp WIP commit; `git stash push -u -m "<unique-tag>"` + `git stash apply <sha>`
+ tagged drop; NEVER bare `git stash` / `git stash pop` on the shared stack.
