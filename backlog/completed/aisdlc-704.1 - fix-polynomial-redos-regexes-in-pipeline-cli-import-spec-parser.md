---
id: AISDLC-704.1
title: >-
  fix polynomial ReDoS regexes in pipeline-cli import-spec parser
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
updated_date: '2026-10-07 17:30'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). Rewrite the six polynomial-redos regex sites in `pipeline-cli/src/import-spec/parser.ts` (code-scanning alerts 137, 136, 44, 42, 41, 40: lines ~74, 75, 120, 137, 162, 178) with linear-time matching, with tests that pin the old behaviour and a pathological-input case.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The change described above is implemented with tests.
- [x] The listed code-scanning alerts read `fixed` after merge.

## Final Summary

## Summary
Replaced the six polynomial-ReDoS regex sites in `pipeline-cli/src/import-spec/parser.ts` (code-scanning alerts 137, 136, 44, 42, 41, 40) with an anchored prefix regex plus a linear tail scan.

## Changes
- `pipeline-cli/src/import-spec/parser.ts` (modified): heading, checkbox and AC matchers now use non-overlapping prefix regexes and a hand-rolled `captureTail`; old backtracking edge cases (last-char/last-digit give-back, line-terminator non-match) kept.
- `pipeline-cli/src/import-spec/parser.test.ts` (modified): differential tests against reference copies of the old regexes over 33 sample lines, plus a 50k-tab pathological-input timing case.

## Design decisions
- **Prefix regex + tail scan**: the overlap was `[ \t]*(.+)$`; scanning the tail by hand removes it without changing parse results.
- **Faithful edge cases**: reproduced the old regex's backtracking results so parse output is unchanged for every sampled line.

## Verification
- `pnpm build` — clean
- `pnpm test` — import-spec 164 passed (parser.test.ts 44)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 reviewers approved (code, test, security) after one round-1 fix (CRLF + 2-digit id regression); Codex quota exhausted so Claude-native code and test reviewers were used.

## Follow-up
(none)
