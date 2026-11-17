---
id: AISDLC-1303
title: 'Python and Go SDK version constants follow the released version'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-go
  - sdk-parity
  - release
dependencies: []
references:
  - sdk-python/src/ai_sdlc/__init__.py
  - sdk-python/pyproject.toml
  - sdk-python/README.md
  - sdk-go/aisdlc.go
  - release-please-config.json
  - .release-please-manifest.json
priority: low
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: file the three mechanical SDK parity tasks of the survey. The survey read the values: Python `__version__` is 0.1.0 while the package is 0.3.0; Go `Version` is 0.1.1 while the release is 0.9.0; the Python README names a package that is not this one.'
---

## Description

**Gap.** `sdk-python/src/ai_sdlc/__init__.py` sets `__version__ = "0.1.0"`; `sdk-python/pyproject.toml` and `.release-please-manifest.json` say 0.3.0. `sdk-go/aisdlc.go` sets `Version = "0.1.1"`; the manifest says 0.9.0. A program that reports the SDK version reports a wrong one, and each release makes the gap larger because release-please does not write these two files. `sdk-python/README.md` tells the reader to run `pip install ai-sdlc`; the published package is `ai-sdlc-framework`.

**Shape.** Each SDK's version constant equals the version of its release, release-please keeps it so, and the Python README names the real package.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: are the constants needed? Yes: both are public and telemetry or user code may read them. 2. Deleted: nothing. 3. Simplified or optimised: release-please writes the constants through `extra-files`; no script of our own. 4. Accelerated: not applicable. 5. Automated: one test per SDK compares the constant with `.release-please-manifest.json`.

- **Constants.** Set `__version__` to the `sdk-python` value and `Version` to the `sdk-go` value of `.release-please-manifest.json`.
- **release-please.** In `release-please-config.json`, add `extra-files` to the `sdk-python` and `sdk-go` packages so that the next release rewrites both constants (generic updater with the `x-release-please-version` marker comment on the constant's line, or the updater type that fits). Do not edit `CHANGELOG.md` or `.release-please-manifest.json`.
- **README.** `sdk-python/README.md` uses the name from `[project].name` of `sdk-python/pyproject.toml` in every install command.
- **Tests.** A Python test and a Go test each read `.release-please-manifest.json` from the repository and assert equality with the constant.

Out of scope: version numbers themselves; any release; the TypeScript SDK.

## Acceptance Criteria

- [ ] #1 `ai_sdlc.__version__` equals the `sdk-python` value of `.release-please-manifest.json`, and a Python test asserts it.
- [ ] #2 `Version` in `sdk-go/aisdlc.go` equals the `sdk-go` value of `.release-please-manifest.json`, and a Go test asserts it.
- [ ] #3 `release-please-config.json` lists both constant files under `extra-files` of their package, and each constant line carries the marker the chosen updater needs.
- [ ] #4 Every install command in `sdk-python/README.md` uses the package name of `sdk-python/pyproject.toml`.
- [ ] #5 `CHANGELOG.md` files and `.release-please-manifest.json` are unchanged.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, and the Python and Go suites pass.
