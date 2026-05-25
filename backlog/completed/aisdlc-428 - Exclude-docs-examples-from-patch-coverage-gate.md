---
id: AISDLC-428
title: Exclude docs/examples/** from patch-coverage gate
status: Done
assignee: []
created_date: '2026-05-25'
completed_date: '2026-05-25'
updated_date: '2026-05-25 17:33'
labels:
  - coverage-gate-fix
  - deferred-from-overnight-drain
dependencies: []
references:
  - scripts/check-pr-patch-coverage.mjs
priority: high
---

# AISDLC-428 — Exclude docs/examples/** from patch-coverage gate

PR #691 (AISDLC-335 docs) added `.ts` example translator files at 
`docs/examples/translators/example-adopter.ts` + `linear-translator.ts`. 
These are documentation scaffolds for adopters, NOT production code, 
but the patch-coverage gate sees them as instrumented files with 0% 
coverage and BLOCKS the PR.

The fix is a one-line addition to `NON_INSTRUMENTED_PATTERNS` in 
`scripts/check-pr-patch-coverage.mjs`:

```js
/(^|\/)docs\/examples\//,
```

Matches the rationale already documented for `bin/*.mjs`, 
`ai-sdlc-plugin/hooks/*.js`, etc. — these are reference scaffolds 
exercised via copy-paste, not via vitest instrumentation.

## Acceptance Criteria
- [x] AC-1: `scripts/check-pr-patch-coverage.mjs` `NON_INSTRUMENTED_PATTERNS` array contains the regex `/(^|\/)docs\/examples\//` matching all paths under `docs/examples/`.
- [x] AC-2: `scripts/check-pr-patch-coverage.test.mjs` contains a regression test that commits a file at `docs/examples/translators/example-adopter.ts`, writes no coverage data, and asserts the gate exits 0 with `reason: 'no-instrumentable-changes'`.
- [x] AC-3: `pnpm test` passes (no regression).
