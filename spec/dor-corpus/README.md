# DoR Test Corpus

Regression suite for the AI-SDLC Definition-of-Ready evaluator
(RFC-0011 §5.6 + §12 Phase 2a).

## Layout

```
spec/dor-corpus/
  ready/                              # 30 fixtures — Stage A admit
  needs-clarification/
    gate-1-untestable-ac/             # 5 fixtures — block on Gate 1
    gate-2-markers/                   # 5 fixtures — block on Gate 2
    gate-3-broken-references/         # 5 fixtures — block on Gate 3
    gate-4-unbounded-scope/           # 5 fixtures — Gate 4 is fully Stage B; Stage A captures the soft-heuristic outputs
    gate-5-no-surface/                # 5 fixtures — block on Gate 5
    gate-6-no-done-state/             # 5 fixtures — Gate 6 is fully Stage B; Stage A captures the soft-heuristic outputs
    gate-7-invisible-deps/            # 5 fixtures — block on Gate 7
  edge-cases/                         # 10 fixtures — auto-pass shortcuts, vacuous passes, multi-gate failures
```

Each fixture is a markdown body file plus an `<name>.expected.json`
sidecar declaring the expected Stage A verdict. The CI gate test
(`pipeline-cli/src/dor/corpus.test.ts`) walks the tree and asserts
100% match.

### Sidecar shape

```jsonc
{
  "overallVerdict": "admit" | "needs-clarification",
  "failsGates": [1, 2, 5],         // optional — gate IDs the fixture MUST fail
  "allowExtraFailures": false,      // default false; opt in for multi-gate fixtures
  "description": "human-readable summary of what this fixture tests"
}
```

### Important notes per RFC §4.4

- **Gates 4 and 6 are fully Stage B** — Stage A always returns
  `verdict: 'skip'` for them. Fixtures in `gate-4-unbounded-scope/` and
  `gate-6-no-done-state/` therefore DO NOT add `4` or `6` to
  `failsGates`. The `overallVerdict` for those is `admit` because Stage
  A has nothing to block on; the `description` documents what Stage B
  (Phase 2b) is expected to catch when it lands.
- **Gate 3 (references)** — the corpus runs in **hermetic** mode by
  default. Network resolvers (github-issue, URL HEAD) are stubbed out;
  only the file-existence resolver runs against the corpus root. To
  test broken github-issue / URL references, the fixture body uses
  references that the file-existence resolver knows are missing
  (`RFC-9999`, `AISDLC-99999`, missing repo paths).

## Updating the corpus

1. Add or modify a fixture under the appropriate bucket.
2. Run `pnpm --filter @ai-sdlc/pipeline-cli vitest run src/dor/corpus.test.ts`.
3. Commit. The CI gate enforces 100% Stage A match — any drift fails
   the build.
