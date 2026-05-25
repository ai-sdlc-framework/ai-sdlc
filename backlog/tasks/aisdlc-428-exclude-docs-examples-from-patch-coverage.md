---
id: AISDLC-428
title: 'Exclude docs/examples/** from patch-coverage gate'
status: To Do
priority: high
assignee: []
labels: [coverage-gate-fix, deferred-from-overnight-drain]
references:
  - 'PR #691'
  - 'scripts/check-pr-patch-coverage.mjs'
acceptanceCriteria:
  - 'Add docs/examples/** to NON_INSTRUMENTED_PATTERNS in scripts/check-pr-patch-coverage.mjs'
  - 'PR #691 (AISDLC-335) coverage gate passes after this fix lands on main + #691 rebases'
  - 'Add regression test in scripts/check-pr-patch-coverage.test.mjs covering the new exclusion'
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

## Scope
1. Add the regex to `NON_INSTRUMENTED_PATTERNS` array
2. Add a test in `scripts/check-pr-patch-coverage.test.mjs` asserting 
   `docs/examples/foo.ts` is filtered out
3. Push as a small focused PR; rebase #691 after merge
