---
id: AISDLC-1265
title: 'Untrusted PR gate: the trust list and the path-gate config load at runtime and a load failure fails closed'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - ucvg
  - bug
dependencies: []
references:
  - pipeline-cli/src/pipeline/trust-classifier.ts
  - pipeline-cli/src/pipeline/trust-classifier.test.ts
  - pipeline-cli/src/pipeline/ast-gate.ts
  - pipeline-cli/src/pipeline/ast-gate.test.ts
  - .ai-sdlc/trusted-reviewers.yaml
  - .ai-sdlc/untrusted-pr-gate.yaml
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
dispatchable: true
dispatchableReason: 'Internal audit 2026-11-13 (finding A1), verified by the planner in the source. Two call sites, one known cause, a bounded fix with tests. First of four fixes that precede switching the gate on.'
---

## Description

**Gap.** Two functions read the gate's YAML configuration with `require('js-yaml')` inside a `try` block: `extractAllowlistedAuthorsFromYaml()` in `pipeline-cli/src/pipeline/trust-classifier.ts` and the config parser in `pipeline-cli/src/pipeline/ast-gate.ts`. `pipeline-cli` is an ES module package, so `require` is not defined when the built CLI runs under plain Node. The call throws, the `catch` returns an empty list or an empty object, and nothing is logged.

Result at runtime:

- The trusted-author list is always empty. Every fork author is classified untrusted, including an author the operator has listed as trusted, so a trusted author's fork PR would spend model credit.
- `protectedPaths` and the other keys of `.ai-sdlc/untrusted-pr-gate.yaml` are never read. Stage 1 runs on the built-in defaults, and editing the YAML changes nothing.

The unit tests pass because Vitest supplies `require`.

**Shape.** Load `js-yaml` with a static `import` in both files. Treat a config that cannot be read or parsed as an error that ends the run in the untrusted or abort outcome, with a message naming the file; never as "no config". Add one test per file that runs the built CLI entry under plain `node` (no Vitest) against a fixture YAML and asserts that the values from the file are in effect.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: RFC-0043 requires the trust list and the protected paths to come from files on `main`; that requirement stands, the code does not meet it. 2. Deleted: the `require` calls, the two eslint suppressions and the silent `catch` fallbacks. 3. Simplified or optimised: one static import per file; one error path. 4. Accelerated: n/a. 5. Automated: a built-CLI test under plain Node, which is the case Vitest hides.

## Acceptance Criteria

- [ ] #1 Neither `trust-classifier.ts` nor `ast-gate.ts` calls `require`; both import `js-yaml` statically.
- [ ] #2 Run under plain `node` from the built `dist`, the trust classifier returns `trusted` for a login listed in a fixture trust file and `untrusted` for one that is not.
- [ ] #3 Run under plain `node` from the built `dist`, the Stage 1 path gate blocks a path that appears only in the fixture YAML's `protectedPaths` and not in the built-in defaults.
- [ ] #4 A config file that is missing, unreadable or not valid YAML ends classification as `untrusted` and ends Stage 1 as a block, each with a message naming the file. No code path returns an empty config on a parse error.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
