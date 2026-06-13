---
id: AISDLC-538
title: >-
  chore(deps): bump Go SDK deps (OpenTelemetry-Go, golang.org/x/oauth2) to
  resolve high-severity advisories
status: Done
assignee: []
labels:
  - security
  - dependencies
  - sdk-go
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - sdk-go/go.mod
  - sdk-go/operator/go.mod
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dependabot reports HIGH advisories against Go modules used by the Go SDK:
- **`go.opentelemetry.io/otel`** (DIRECT, runtime) — multi-value `baggage` header extraction
  vulnerability.
- **`golang.org/x/oauth2`** (transitive, runtime) — improper validation of syntactic correctness
  (JWS/token parsing).

`otel` is a DIRECT dependency, so it's the priority. **Fix:** in `sdk-go/go.mod` (and
`sdk-go/operator/go.mod` if it pins these independently), `go get` the patched versions of
`go.opentelemetry.io/otel` (+ its companion modules like `.../otel/sdk`, `.../otel/trace` if
they version together) and `golang.org/x/oauth2`, then `go mod tidy`. Run `go build ./...` and
`go test ./...` in both modules to confirm no breakage. Keep the two go.mod files consistent.

Verify exact patched versions against the live dependabot alert list (`gh api
repos/<org>/<repo>/dependabot/alerts?state=open`) at implementation time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `go.opentelemetry.io/otel` (and companion otel modules) bumped to the patched version in sdk-go/go.mod; the baggage-header advisory clears
- [ ] #2 `golang.org/x/oauth2` bumped to the patched version (directly or via the dep that pulls it); the oauth2 advisory clears
- [ ] #3 `go mod tidy` run; sdk-go/go.mod and sdk-go/operator/go.mod kept consistent
- [ ] #4 `go build ./...` and `go test ./...` pass in both modules
- [ ] #5 Post-merge dependabot re-scan shows the otel + oauth2 HIGH advisories resolved
<!-- AC:END -->
