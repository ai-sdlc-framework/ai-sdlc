---
id: AISDLC-611
title: Propagate the no-bare-stash rule to developer/reviewer subagents (data-loss guard)
status: Done
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

## Final summary

Implemented both belt-and-suspenders layers.

**PreToolUse guard** — `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` gained
`enforceStashGovernance()`, wired unconditionally into `enforceBash()` (same
unconditional-enforcement pattern as the AISDLC-602 merge governance). It:

- Strips heredoc bodies before segment-splitting (`stripHeredocBodies`) so
  documentation/example text quoting `git stash pop` inside a `cat <<EOF`
  block is never mistaken for a real invocation.
- Splits on shell control operators (reusing `splitShellSegments`) so chained
  commands (`x && git stash pop`) are caught per-segment.
- Requires the segment's first non-env-assignment token to be `git` (not just
  a substring match), so `echo "git stash pop"` / a path containing "stash" /
  `git commit -m stash` are never flagged.
- Scans past global git flags (`-C <dir>`, `-c <k=v>`, etc.) to find the
  `stash` subcommand token, then dispatches on subcommand: `pop` always
  blocks; bare `stash`/untagged `push`/`save` (no `-m`/`--message`/positional
  tag) block; bare `drop` (no explicit ref) blocks; any unrecognized
  subcommand (`clear`, `branch`, `create`, `store`, ...) blocks fail-closed;
  `apply`, `list`, `show`, and ref'd `drop` are allowed.
- Denial messages point at the safe pattern: prefer a temp WIP commit, else
  `git stash push -u -m "<tag>"` + `git stash apply <ref>` + `git stash drop
  <ref>`.

29 new hermetic `node --test` cases in
`ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs` cover every block/allow
case plus evasion shapes (chained `&&`/`;`/`||`, quote-splitting the `stash`
token, global `-C` flag insertion, a decoy `--message=` in a different chained
segment) and no-over-block cases (paths, echo/heredoc text, `git commit -m
stash`, unrelated pnpm scripts).

**Agent definitions** — `ai-sdlc-plugin/agents/developer.md` gained Hard rule
#10 stating the no-bare-stash constraint and safe pattern, referencing the
LT-595 incident and the PreToolUse hook as the authoritative backstop.
`code-reviewer.md` and `test-reviewer.md` (both have Bash tool access) each
gained a short "Git safety" section with the same rule, scoped to their
actual usage (they don't modify the working tree, but may shell out to `git`
while inspecting a diff).

Verification: `pnpm build && pnpm test && pnpm lint && pnpm format:check`
clean; `node --test ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs`
— 98 tests total in the file (29 new stash-governance tests), 0 failures.
