---
id: AISDLC-605.1
title: 'merge matcher: reduce over-blocking with a real tokenizer'
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - plugin
  - governance
  - enforce-blocked-actions
  - follow-up
dependencies:
  - AISDLC-605
priority: low
dispatchable: true
---

## Description

AISDLC-605 (planner ruling, positive grammar) made `ai-sdlc-plugin/hooks/lib/merge-matcher.js` fail closed by construction. A command segment is PLAIN only when it consists entirely of whitespace-separated words, each either bare ASCII characters from `[A-Za-z0-9_./=:@+,%-]` or exactly one balanced single- or double-quoted string with no `$`, backtick or backslash (bare characters glued to a quote make the word non-plain). Everything else (`$`, backtick, parens, braces, `<`, `>`, `|`, `&`, `;`, `#`, backslash, unbalanced or glued quotes, non-ASCII) makes the whole segment OPAQUE. The precise matcher (gh word scan, inert allowlist, pipe-stage tracking) runs only on plain segments; when any segment is opaque and the raw command mentions a merge phrase (the words `pr` and `merge`, the pulls-merge API path or the merge mutations), the command is refused. That closes every shell-expansion bypass found in rounds 3-11 but over-blocks harmless opaque commands that mention the phrase, for example `gh api ... -q $'.x'`, `gh release create --notes $'x'`, any `$VAR`, a `>` redirection, or a trailing `# comment` that mentions pr and merge.

Replace the positive-grammar opaque-segment rule with a real shell tokenizer that expands brace expansion, IFS, ANSI-C quoting, backslash-newline, variable assignment, redirections and comments into plain words, so those harmless commands are no longer blocked. Indirection through user variables, stored scripts and planted files stays out of scope: branch protection and `cli-merge-if-eligible` are the backstop.

## Acceptance Criteria

- [ ] A real tokenizer normalises brace expansion, `$IFS`/`${IFS}`, ANSI-C `$'...'` (including `\'` escapes in the splitter and comment stripper), backslash-newline and leading variable assignments.
- [ ] `gh api ... -q $'.x'` and `gh release create --notes $'x'` are allowed.
- [ ] Every bypass test from AISDLC-605 rounds 3 through 11 stays refused (`merge-matcher.test.mjs` and `enforce-blocked-actions.test.mjs`).
- [ ] Previously allowed inert commands (echo prose, `git commit -m` text, `gh pr view`, `gh alias list`, `gh pr list --repo`) stay allowed.

## Out of scope notes carried from AISDLC-605 round 12

Found in the final review of the positive grammar and deliberately not fixed in AISDLC-605; this task or a sibling should pick them up:

- `+` is in the bare character set, so interpreter string concatenation (`node -e "'pr' + ' mer' + 'ge'"`) is not seen as the phrase.
- `pr` plus `$'` over-blocks harmless commands such as `tr -d $'\r'` (the mention test treats `$'` as a hidden word).
- The branch-merge API surface (`/merges`, the `mergeBranch` mutation) is not covered by the PR merge path matcher.
- The permission-check hook fails open on its own errors.
