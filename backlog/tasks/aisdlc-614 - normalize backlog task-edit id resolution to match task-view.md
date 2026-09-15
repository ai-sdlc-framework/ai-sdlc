---
id: AISDLC-614
title: Normalize backlog `task edit` id resolution to match `task view` (LOW-6)
status: To Do
priority: low
labels:
  - backlog-cli
  - adopter-facing
created: 2026-09-14
---

## Context

LOW-6 from the local-trades LT-595 report: `backlog task edit <bare-number>`
reports "not found" for an id that `backlog task <bare-number>` (view) resolves
fine — `edit` requires the full prefixed `LT-NNN` while `view` accepts the bare
number. Inconsistent id normalization between subcommands; minor friction.

## Scope

- Make `task edit` (and any other id-taking subcommand) accept the SAME id forms
  `task view` accepts: bare number (`595`), prefixed (`LT-595`), and full/exact.
  Route all id-taking subcommands through one shared id-normalization helper so
  they can't drift again.

## Acceptance Criteria

- [ ] AC-1: `task edit 595`, `task edit LT-595`, and `task edit lt-595` all
      resolve the same task as `task view 595` does.
- [ ] AC-2: A shared normalizer is used by view/edit/(and other id-taking
      subcommands); a test asserts view and edit accept an identical id-form set.
- [ ] AC-3: Unknown id still errors clearly (no false-resolve). Build/test/lint clean.

## References

Adopter report local-trades LT-595 (LOW-6). Note: this concerns the Backlog.md
CLI id normalization; confirm whether the fix belongs in this repo's backlog
tooling or upstream Backlog.md before implementing.
