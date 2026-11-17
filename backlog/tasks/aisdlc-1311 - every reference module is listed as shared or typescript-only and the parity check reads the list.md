---
id: AISDLC-1311
title: 'Every reference module is listed as shared or TypeScript-only and the parity check reads the list'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-go
  - sdk-parity
  - conformance
dependencies:
  - AISDLC-1305
references:
  - reference/src
  - sdk-typescript/package.json
  - sdk-python/src/ai_sdlc
  - sdk-go
  - conformance/README.md
  - sdk-python/README.md
  - sdk-go/README.md
  - spec/rfcs/RFC-0013-product-first-implementation-strategy.md
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: "draft 1, 2 and 4 and file them" (item 4: the scope ruling is not machine-read). Operator ruling of the same day: SDK scope is the narrow roles of RFC-0013 plus the core contract; judgment, usage, capabilities and design-system stay TypeScript-only. The survey read the trees: `reference/src/` has 16 directories; 11 have a counterpart in both SDKs; `capabilities`, `judgment`, `models`, `usage` and `utils` have none, and no file says so.'
---

## Description

**Gap.** `reference/src/` has 16 module directories. Eleven (`adapters`, `agents`, `audit`, `builders`, `compliance`, `core`, `metrics`, `policy`, `reconciler`, `security`, `telemetry`) are exported by `sdk-typescript/package.json` and have a package in `sdk-python/src/ai_sdlc/` and a directory in `sdk-go/`. Five (`capabilities`, `judgment`, `models`, `usage`, `utils`) exist only in the reference. Which module an SDK must carry is written in no file that a check reads, so a module added to the reference is classified by nobody and an SDK may lack it without notice.

**Shape.** One committed file names every directory of `reference/src/` with a class. `parity:check` fails when a directory is not in the file, when the file names a directory that does not exist, and when a module of class `shared` has no counterpart in an SDK. The two SDK READMEs state the same scope.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a file needed when a decision record holds the ruling? Yes: a record is read by people; a new module must fail a check until someone classifies it. 2. Deleted: nothing. 3. Simplified or optimised: directory granularity only; the check tests that a counterpart exists, not what it contains (names are the parity manifest's work). 4. Accelerated: not applicable. 5. Automated: the check is part of `parity:check`, which the root `test` script runs.

- **File.** `conformance/parity/scope.json`: an object keyed by directory name of `reference/src/`, sorted; each value has `class` (`shared`, `typescript-only` or `internal`) and, for the last two, a non-empty `reason`. Initial content: the eleven directories named above are `shared`; `capabilities`, `judgment` and `usage` are `typescript-only` with the reason "Operator ruling of 2026-11-17: SDK scope is the roles of RFC-0013 plus the core contract"; `models` is `typescript-only` with the reason that it serves the TypeScript agent runners only; `utils` is `internal`. Follow the tree when the work starts: a directory not named in this task gets no class from the developer (see the stop rule).
- **Check.** `parity:check` (the script of AISDLC-1305) also fails, with the directory name and the file to edit, when: a directory of `reference/src/` has no entry; an entry names no directory; an entry has an unknown class or lacks a reason where one is needed; a `shared` directory has no directory of the same name under `sdk-python/src/ai_sdlc/` or under `sdk-go/`; a `shared` directory has no `./<name>` key in the `exports` of `sdk-typescript/package.json`.
- **Docs.** `conformance/README.md`, section "Parity manifest": what `scope.json` is, and that moving a module to `typescript-only` or adding a new one with that class needs an operator decision named in the PR body. `sdk-python/README.md` and `sdk-go/README.md` each gain a short section "Scope" that lists the shared modules and names the TypeScript-only ones, with a link to `scope.json`.
- **Stop rule.** If `reference/src/` has a directory that this task does not name, or a `shared` module lacks a counterpart on the base tree, do not classify it and do not create an empty package; report the directory in the verdict notes and stop.

Out of scope: design-system code, which lives inside `adapters`, `policy` and `reconciler` and is not a directory; porting any module; the contents of a module; `orchestrator/` and other packages outside `reference/`.

## Acceptance Criteria

- [ ] #1 `conformance/parity/scope.json` has one entry per directory of `reference/src/` with the classes stated above.
- [ ] #2 `pnpm parity:check` fails when a directory is added under `reference/src/` without an entry; a test of the script asserts this on a fixture.
- [ ] #3 `pnpm parity:check` fails when a `shared` entry has no counterpart in the Python SDK, in the Go SDK or in the `exports` of `sdk-typescript/package.json`; a test of the script asserts each of the three cases on a fixture.
- [ ] #4 `pnpm parity:check` fails on an entry without a directory, an unknown class, or a missing reason; a test asserts each case.
- [ ] #5 `conformance/README.md`, `sdk-python/README.md` and `sdk-go/README.md` describe the scope as stated above.
- [ ] #6 No file under `reference/src/`, `sdk-python/src/` or a Go package directory of `sdk-go/` is in the diff.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
