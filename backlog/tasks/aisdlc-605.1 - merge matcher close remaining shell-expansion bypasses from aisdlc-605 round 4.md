---
id: AISDLC-605.1
title: >-
  merge matcher: close remaining shell-expansion bypasses found in AISDLC-605 round 4
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
priority: high
dispatchable: true
---

## Description

Follow-up from AISDLC-605 round 4 (security and code review of PR #1275). These are the remaining ways a real PR-merge command passes `ai-sdlc-plugin/hooks/lib/merge-matcher.js` in a single call. Fix them as refused shapes with tests, preferably through one shell-accurate normalizer applied before matching (`$IFS` to space, other variables to empty, remove backslash-newline, expand braces into separate words, honor ANSI-C escapes in the splitter and comment stripper).

Indirection through user variables, stored scripts and planted files stays out of scope: branch protection and `cli-merge-if-eligible` are the backstop.

## Acceptance Criteria

- [ ] ANSI-C quote parsing: `$'...'` honors backslash escapes (`\'`) in the segment splitter and the comment stripper, so `echo $'\''; <merge command> #'` is refused.
- [ ] Backslash-newline inside a word (`gh pr mer\<newline>ge 42`) is removed before matching.
- [ ] Brace expansion across words (`{gh,pr} merge 42`, `gh {pr,merge} 42`, `{gh,pr,merge} 42`) is expanded into separate words before tokenizing.
- [ ] `${IFS}` and `$IFS` separators (`gh${IFS}pr${IFS}merge 42`) are treated as spaces, matching the stash guard and the API-merge normalizer.
- [ ] Expansion in the subcommand slot (`gh pr $(echo x) 5`, `gh pr $A 5`) is refused when the segment is not inert.
- [ ] Minors: scope the `$'`/`$"` refusal to the first non-flag words after gh (it over-blocks `gh api ... -q $'.x'`); path globs in the gh command word (`g[h]`); unlisted value-taking flags between `pr` and `merge`.
- [ ] Previously allowed inert commands (echo prose, `git commit -m` text, `gh pr view`, `gh alias list`) stay allowed.
