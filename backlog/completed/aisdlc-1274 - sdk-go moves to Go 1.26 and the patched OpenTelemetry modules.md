---
id: AISDLC-1274
title: 'sdk-go: move to Go 1.26 and the patched OpenTelemetry modules (Dependabot alert 173)'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - sdk-go
  - ci
  - security
dependencies: []
references:
  - sdk-go/go.mod
  - sdk-go/go.sum
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ci.yml
  - .github/workflows/main-health-monitor.yml
priority: medium
dispatchable: true
dispatchableReason: 'Dependabot security PR 2653 (alert 173, medium, go.opentelemetry.io/otel/trace below 1.47.0) was routed to the planner as a real failure on 2026-11-13. The planner read the failing job: the patched modules require Go 1.26 and the three workflows that test sdk-go pin Go 1.25. One module file, its sum file and three one-line workflow pins.'
---

## Description

**Gap.** Dependabot alert 173 (medium) reports that `go.opentelemetry.io/otel/trace` below 1.47.0 lets attribute values bypass `AttributeValueLengthLimit`. `sdk-go/go.mod` requires 1.41.0. Dependabot opened pull request 2653 with the bump, and it cannot land:

- `Test Go SDK` fails with `go.mod requires go >= 1.26.0 (running go 1.25.14; GOTOOLCHAIN=local)`. The patched modules raise the `go` directive to 1.26.0, and the three workflows that run the sdk-go tests install Go 1.25.
- `ai-sdlc/issue-link` fails because a Dependabot security pull request for Go carries no linked task and no bypass label.

Go 1.25 left upstream support when Go 1.27 was released, so raising the floor to 1.26 follows the upstream support window.

**Shape.** One task pull request makes the same dependency change as pull request 2653 and raises the Go version in CI with it. Its title carries this task id, so the issue-link check passes without a label. Dependabot closes its own pull request once main holds the patched version.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the requirement is that sdk-go ships without the vulnerable module and that its tests run on a supported Go; both hold only if the module bump and the CI Go version change together. 2. Deleted: no label change and no Dependabot configuration change; the task pull request replaces pull request 2653 instead of repairing it. 3. Simplified or optimised: one pull request for the module file, the sum file and the three pins. 4. Accelerated: n/a. 5. Automated: the existing `Test Go SDK` job is the check.

## Acceptance Criteria

- [ ] #1 `sdk-go/go.mod` requires `go.opentelemetry.io/otel`, `go.opentelemetry.io/otel/metric` and `go.opentelemetry.io/otel/trace` at 1.47.0 or later, with the `go` directive the modules need; `go.sum` is regenerated with `go mod tidy`.
- [ ] #2 The `go-version` pin for the sdk-go test job reads `'1.26'` in `.github/workflows/ai-sdlc-gate.yml`, `.github/workflows/ci.yml` and `.github/workflows/main-health-monitor.yml`; a search of the repository finds no other place that states Go 1.25 as the sdk-go version, or each one found is updated.
- [ ] #3 `go build ./... && go test ./... -count=1` pass in `sdk-go` on Go 1.26, and `Test Go SDK` is green on the pull request.
- [ ] #4 Any sdk-go source change the new module versions force is limited to what the compiler or a failing test requires, and the PR body lists each one.
- [ ] #5 The PR body names Dependabot pull request 2653 and alert 173 as what this replaces; the executor does not close pull request 2653.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
