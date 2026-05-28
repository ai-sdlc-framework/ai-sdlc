---
id: aisdlc-459
title: 'DoR Gate 7 — extension-whitelist still matches contrived version tokens (v2.5.json edge case)'
status: To Do
created: '2026-05-27'
priority: low
labels: [dor-gate, regex, refinement]
parent: AISDLC-457
references: [AISDLC-457]
acceptanceCriteria:
  - 'Add a regression test in `pipeline-cli/src/dor/gates/gate-7-deps.test.ts` covering `after v2.5.json ships` and `after 1.0.toml lands` (both should NOT match)'
  - 'Tighten the extension-only file-path alternative to require either a path-like prefix (no leading `v`+digit) OR require the token to be a real on-disk file when the gate runs in a worktree context'
  - 'OR: accept the edge case and document it in the gate body — contrived prose like `v2.5.json` is unlikely in real task bodies; the noise:signal trade-off may not justify further regex complexity'
---

## Context

Codex code-reviewer flagged this during re-review of PR #748 (AISDLC-457). The tightened regex from AISDLC-457 closes the common false positives (`1.2`, `v0.10.0`) but still matches contrived combinations like `v2.5.json` because `json` is in the whitelisted extension set. This is a narrower edge case than the AISDLC-457 fix scope; filing as a follow-up refinement.

## Acceptance criteria

- See frontmatter.

## Reference

- PR #748 codex re-review verdict
- `pipeline-cli/src/dor/gates/gate-7-deps.ts` TRACKED_WORK_ID extension alternative
