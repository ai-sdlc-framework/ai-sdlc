# Staged review: the tree-sitter structural provider

RFC-0052 Stage 1 needs, for each changed hunk, the symbols it touches, who calls them, what
they call, and which tests mention them. `TreeSitterStructuralProvider`
(`pipeline-cli/src/review-risk-map/tree-sitter-provider.ts`) produces those facts with
tree-sitter WASM grammars. The same provider backs the `dependencyQuery` hook that the review
executor calls for `trace` probes.

## Wiring

```ts
import {
  buildRiskMap,
  createTreeSitterDependencyQuery,
  TreeSitterStructuralProvider,
  executePlan,
} from '@ai-sdlc/pipeline-cli';

// Stage 1: facts per hunk, read from the commit the diff ends at.
const structural = new TreeSitterStructuralProvider({ repoRoot, commit: headSha });
await buildRiskMap(diff, { structural });

// Stage 4: `trace` probes get callers and callees as fenced data.
await executePlan(plan, spawner, limits, { dependencyQuery: createTreeSitterDependencyQuery() });
```

Pass nothing and nothing changes: `buildRiskMap` keeps the default provider, every hunk's
structural facts are `unavailable` and the hunk ranks as high risk. A `trace` probe with no
`dependencyQuery` wired is still refused.

## Supported languages

| Language | Extensions | Grammar |
| --- | --- | --- |
| TypeScript | `.ts` `.mts` `.cts` | `tree-sitter-typescript.wasm` |
| TSX | `.tsx` | `tree-sitter-tsx.wasm` |
| JavaScript | `.js` `.mjs` `.cjs` `.jsx` | `tree-sitter-javascript.wasm` |
| Python | `.py` | `tree-sitter-python.wasm` |
| Go | `.go` | `tree-sitter-go.wasm` |

The grammars come from the `tree-sitter-wasms` package and load through `web-tree-sitter`.
Nothing is downloaded at run time. TypeScript, TSX and JavaScript share one call namespace (the
`ecmascript` family); Python and Go are each their own.

A file in any other language, or in a supported language whose grammar did not load, has
`unavailable` facts with reason `no-grammar`. That never fails the risk map.

Declarations reported: functions (including `const f = () => ...`), methods, classes (and Go
types), exported constants (module-level constants in Python, capitalised `const` in Go).

## What is read

Everything is read from git objects at the given commit: `git ls-tree -r -l` for the tracked
file list and sizes, `git cat-file blob` for content, and `git grep` at the commit to find the
files that mention a symbol. An untracked or gitignored file (a local `.env`, a scratch script)
is never opened and never searched, and a changed file that is not tracked at the commit is
`unavailable` with reason `not-tracked`.

## Callers are matched by name

A call `x.save()` is recorded as a call to `save`. The provider does not resolve types, imports
or receivers, so:

- a caller of an unrelated function that happens to share the name is reported (false positive);
- a call made through an alias, a dynamic dispatch or generated code is missed (false negative);
- a callee is shown as `path#name` when a searched file declares that name, otherwise as the bare
  name (a library or built-in call).

False positives raise a hunk's risk rank, which is the safe direction. Callers are only looked
for in tracked files of the same language family, and test files (`*.test.*`, `*.spec.*`,
`test_*.py`, `*_test.go`, `tests/`, `__tests__/`) are reported as referencing tests rather than
as callers.

## Limits and unavailable reasons

Caps (defaults in `DEFAULT_STRUCTURAL_LIMITS`, override with `limits`):

| Cap | Default | When it bites |
| --- | --- | --- |
| `maxFilesParsed` | 200 | Further changed files are `unavailable` (`file-cap`); further candidate files are skipped and `files-parsed-cap` is recorded |
| `maxBytesPerFile` | 512 KiB | The file is `unavailable` (`file-too-large`) |
| `maxResultsPerSymbol` | 50 | Callers, callees or tests are cut and `<list>-truncated:<symbol>` is recorded |
| `parseBudgetMs` | 10 s per hunk or query | The file is `unavailable` (`budget-exceeded`); the parse is cancelled |

A changed file's facts are `unavailable` with exactly one reason: `not-tracked`, `no-grammar`,
`file-too-large`, `parse-error` (the file has a syntax error), `budget-exceeded`, `file-cap` or
`git-error`. A candidate file that cannot be searched is skipped, not fatal. Both are visible
through `provider.report()` (per-file outcomes, `skippedCandidates`, `truncations`). The provider
never throws.

## Adding a grammar

1. Install a grammar `.wasm` built for the `web-tree-sitter` version in `pipeline-cli/package.json`
   (the `tree-sitter-wasms` package ships many; check the ABI loads, since a grammar built by a
   much newer or older tree-sitter CLI fails to load and becomes `no-grammar`).
2. In `tree-sitter-languages.ts` add the grammar to `GrammarId`, `SPECS` (family and wasm file)
   and `EXTENSIONS`. Add a new `LanguageFamily` if its calls cannot be matched against an
   existing language.
3. In `tree-sitter-extract.ts` add a `visit<Language>` function mapping the grammar's node types to
   declarations and call sites, and dispatch to it from `extractFileFacts`.
4. Add a fixture (a changed function, callers and callees in other files, a test file) to
   `tree-sitter-provider.test.ts`.

To use a grammar file that is not in `tree-sitter-wasms`, pass `grammarPaths` to the provider.
