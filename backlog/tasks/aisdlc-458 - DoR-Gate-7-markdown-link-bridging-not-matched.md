---
id: aisdlc-458
title: 'DoR Gate 7 — markdown-link bridging in dep-phrase pattern (pre-existing limitation)'
status: To Do
created: '2026-05-27'
priority: low
labels: [dor-gate, regex, refinement]
parent: AISDLC-457
references: [AISDLC-457]
acceptanceCriteria:
  - 'Add a regression test in `pipeline-cli/src/dor/gates/gate-7-deps.test.ts` documenting the current behaviour where `depends on [auth rewrite](https://github.com/org/repo/issues/42)` does NOT produce an offender'
  - 'Decide whether to (a) extend the connector pattern to bridge across `[...](` markdown-link syntax, or (b) keep current narrow connector list + document in task-author guidance that links MUST be unbracketed'
  - 'If (a): update `DEP_PHRASE_WITH_REF_RE` in `gate-7-deps.ts` and prove via test that `depends on [auth](https://...)` now matches the URL alternative'
  - 'If (b): add a one-line note to task-template README about preferring bare URLs in dep-phrase prose'
---

## Context

Codex code-reviewer flagged this during re-review of PR #748 (AISDLC-457). Verified via `git show HEAD~1` that the connector pattern in `DEP_PHRASE_WITH_REF_RE` has never permitted bracket characters between the dep phrase and the tracked-work id — this limitation predates AISDLC-457's regex tightening. Filing as a follow-up so the existing behavior is either tightened or documented, but it is NOT a regression from the file-path narrowing in AISDLC-457.

## Acceptance criteria

- See frontmatter.

## Reference

- PR #748 codex re-review verdict (suppressed MAJOR with documented reason)
- `pipeline-cli/src/dor/gates/gate-7-deps.ts` `DEP_PHRASE_WITH_REF_RE`
