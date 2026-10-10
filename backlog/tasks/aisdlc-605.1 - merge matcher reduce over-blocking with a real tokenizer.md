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

AISDLC-605 round 5 made `ai-sdlc-plugin/hooks/lib/merge-matcher.js` fail closed structurally: any command segment holding a construct the tokenizer does not fully understand (ANSI-C or locale quoting, backslash-newline, brace expansion, IFS, a variable-assignment prefix, substitutions in the command or subcommand slots, globs in the command word) is opaque, and an opaque command that mentions the merge phrase is refused. That closes the shell-expansion bypasses but over-blocks legitimately opaque, harmless commands, for example `gh api ... -q $'.x'` and `gh release create --notes $'x'`.

Replace the opaque-segment fail-closed rule with a real shell tokenizer that expands brace expansion, IFS, ANSI-C quoting, backslash-newline and variable assignment into plain words, so those harmless commands are no longer blocked. Indirection through user variables, stored scripts and planted files stays out of scope: branch protection and `cli-merge-if-eligible` are the backstop.

## Acceptance Criteria

- [ ] A real tokenizer normalises brace expansion, `$IFS`/`${IFS}`, ANSI-C `$'...'` (including `\'` escapes in the splitter and comment stripper), backslash-newline and leading variable assignments.
- [ ] `gh api ... -q $'.x'` and `gh release create --notes $'x'` are allowed.
- [ ] Every bypass test from AISDLC-605 rounds 3, 4 and 5 stays refused (`merge-matcher.test.mjs` and `enforce-blocked-actions.test.mjs`).
- [ ] Previously allowed inert commands (echo prose, `git commit -m` text, `gh pr view`, `gh alias list`, `gh pr list --repo`) stay allowed.
