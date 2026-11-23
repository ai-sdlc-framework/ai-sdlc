---
id: AISDLC-1295
title: 'Untrusted PR gate allows Python and Go source files of the two SDKs'
status: Done
assignee: []
created_date: '2026-11-17'
labels:
  - untrusted-pr-gate
  - governance-config
dependencies: []
references:
  - .ai-sdlc/untrusted-pr-gate.yaml
  - pipeline-cli/src/pipeline/ast-gate.ts
  - pipeline-cli/src/pipeline/ast-gate.test.ts
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
dispatchableReason: 'Operator decision of 2026-11-16 (decision rubric): the allowed list stays as it is until the gate sandbox runs the Python and Go suites, then it is widened to `sdk-python/**/*.py` and `sdk-go/**/*.go`. The suites landed with AISDLC-1293 (#2719). Fork PR #2683 (8 changed lines in `reference/src/compliance/mappings.ts` and `sdk-python/src/ai_sdlc/compliance/mappings.py`) is blocked at Stage 1 only because `.py` is not on the list.'
---

## Description

**Gap.** `allowedMutationGlobs` in `.ai-sdlc/untrusted-pr-gate.yaml` lists `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx` and `**/*.md`. A pull request of an outside contributor that changes a Python or Go file stops at Stage 1 and waits for a maintainer, although the sandbox now runs the Python suite for `sdk-python/**` and the Go suite for `sdk-go/**` (`sandboxSuites` in the same file).

**Shape.** An outside contributor's change to a Python source file under `sdk-python/` or a Go source file under `sdk-go/` passes Stage 1 and reaches the sandbox suite of its language. Python and Go files anywhere else stay blocked, and every protected path stays protected.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a wider list needed? Yes: without it the two suites never run for an outsider, and the operator reviews every such pull request by hand. 2. Deleted: nothing. 3. Simplified or optimised: two globs scoped to the two SDK directories, not `**/*.py` and `**/*.go`. 4. Accelerated: not applicable. 5. Automated: a test reads the real configuration file, so a later edit that drops or widens the globs fails CI.

- **Configuration.** In `.ai-sdlc/untrusted-pr-gate.yaml`, add to `allowedMutationGlobs` exactly two entries: `'sdk-python/**/*.py'` and `'sdk-go/**/*.go'`. No other key changes.
- **Why this is within the recorded decision.** The operator chose this widening on 2026-11-16 on the condition that the sandbox runs both suites; that condition is met on `main`. `protectedPaths` wins over the allowed list, so `go.mod`, `go.sum`, `pyproject.toml` and workflow files stay outside it (they match no allowed glob). State this in the PR body.
- **Test.** `ast-gate.test.ts` gains cases that load the repository's own `.ai-sdlc/untrusted-pr-gate.yaml`.
- **Docs.** The untrusted PR gate section of `docs/operations/quality-gate.md` lists the two new globs.

Out of scope: `.mjs` files; any change to `protectedPaths`, `contentHeuristics` or `sandboxSuites`; re-running the gate on open pull requests.

## Acceptance Criteria

- [ ] #1 `allowedMutationGlobs` in `.ai-sdlc/untrusted-pr-gate.yaml` contains `sdk-python/**/*.py` and `sdk-go/**/*.go`, and the diff of that file adds these two lines and nothing else.
- [ ] #2 A test that loads the repository's own configuration passes Stage 1 for a diff that changes `sdk-python/src/ai_sdlc/compliance/mappings.py` and for a diff that changes `sdk-go/operator/main.go`.
- [ ] #3 With the same configuration, Stage 1 still blocks a diff that changes `scripts/tool.py`, `sdk-go/go.mod`, `sdk-python/pyproject.toml` or `.github/workflows/ci.yml`; a test asserts each of the four.
- [ ] #4 `docs/operations/quality-gate.md` lists the two globs.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
