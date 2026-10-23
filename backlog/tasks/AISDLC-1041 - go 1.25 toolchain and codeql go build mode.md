---
id: AISDLC-1041
title: 'Dependency: raise the Go toolchain to 1.25 in CI and the Go SDK so golang.org/x/net 0.55 lands, and fix the CodeQL Go build mode'
status: In Progress
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - ci
  - sdk-go
dependencies: []
references:
  - sdk-go/operator/go.mod
  - .github/workflows/ci.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/main-health-monitor.yml
  - .github/workflows/codeql.yml
priority: medium
dispatchable: true
---

## Description

Dependabot PR #1705 (golang.org/x/net 0.38.0 to 0.55.0 in `sdk-go/operator`) has been red since 2026-10-16. Two distinct causes:

```
Test Go SDK: go: go.mod requires go >= 1.25.0 (running go 1.24.13; GOTOOLCHAIN=local)
Analyze (go): A fatal error occurred: Go does not support the none build mode. Please try using one of the following build modes instead: autobuild, manual.
```

The new x/net raises the `go` directive to 1.25 while the three workflows pin `go-version: '1.24'`. The CodeQL failure is independent of the bump: the Go matrix entry sets `build-mode: none`, which CodeQL rejects for Go, so every Go analysis has been failing. Raise the pin to 1.25 in `.github/workflows/ci.yml`, `.github/workflows/ai-sdlc-gate.yml` and `.github/workflows/main-health-monitor.yml`, align `sdk-go/operator/go.mod`, bump x/net, and set the Go matrix entry of `.github/workflows/codeql.yml` to `autobuild`.

**Five-step review (requirements first).** Requirement questioned: does the repository need this dependency at the new version at all, or can the bump be dropped? Deletion: the stale Dependabot PR is not closed by us; once main carries the bump Dependabot retires it on its own. Simplified: one PR that bumps the package and adapts the code, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the exact compile or format error quoted below, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [ ] `go-version` is 1.25 in ci.yml, ai-sdlc-gate.yml and main-health-monitor.yml; `go.mod` directive and toolchain agree.
- [ ] golang.org/x/net 0.55.x in `go.sum`; Test Go SDK green.
- [ ] CodeQL Go analysis uses `autobuild` and the Analyze (go) job is green on the PR.
- [ ] `ai-sdlc/pr-ready` green; PR body names Dependabot PR #1705 as superseded; nobody closes it by hand.
