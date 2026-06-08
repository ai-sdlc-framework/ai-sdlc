---
id: AISDLC-505
title: >-
  fix: globToRegex over-matches '**/'-prefixed and '**/.github/**' patterns
  (RFC-0043 ast-gate false-positive)
status: To Do
assignee: []
created_date: '2026-06-03 01:26'
labels:
  - rfc-0043
  - ast-gate
  - bug
  - review-follow-up
dependencies: []
references:
  - pipeline-cli/src/pipeline/ast-gate.ts
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Non-blocking minor findings from PR #843 (AISDLC-497, RFC-0043 Phase 1) code re-review. The minimal `globToRegex()` in `pipeline-cli/src/pipeline/ast-gate.ts` consumes the `/` separator after `**`, widening matches:

1. `**/pnpm-lock.yaml` compiles to `/^.*pnpm-lock\.yaml$/` instead of `/^(.*\/)?pnpm-lock\.yaml$/` — so a file literally named `bad-pnpm-lock.yaml` is falsely matched as protected. Same for the other lockfile globs.
2. `**/.github/**` compiles to `/^.*\.github\/.*$/` which matches `.github/` as a substring anywhere — so a dir like `myproject.github/` is falsely matched.

Both are **conservative over-blocking false-positives, NOT security bypasses** (no real protected file evades the pattern; the gate is fail-closed/deny-wins). Impact is latent until RFC-0043 Phase 5 (AISDLC-501) wires the AST gate into enforcement — a falsely-blocked legitimate untrusted PR would just need maintainer review. Worth fixing for correctness before Phase 5 enforcement.

## Fix
In `globToRegex()`, make `**/` compile to `(?:.*/)?` (optional path prefix anchored at a separator boundary) rather than consuming the `/` into a bare `.*`. Add tests: `bad-pnpm-lock.yaml` is NOT blocked; a real `packages/x/pnpm-lock.yaml` IS blocked; `myproject.github/foo` is NOT blocked; `packages/x/.github/action.yml` IS blocked.

## Also (from security re-review, non-blocking)
Converge the `trusted-reviewers-drift.yml` allowlist parser (currently Python `yaml.safe_load`) onto the same parser as the runtime classifier (now `js-yaml`) to fully retire the parser-divergence risk class.

Surfaced 2026-06-02 during PR #843 reconcile (iter-2 reviews).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 globToRegex compiles '**/'-prefixed patterns to an anchored optional-prefix form so 'bad-pnpm-lock.yaml' is NOT matched by '**/pnpm-lock.yaml' while 'packages/x/pnpm-lock.yaml' IS
- [ ] #2 '**/.github/**' no longer matches substring dirs like 'myproject.github/' while real nested '.github/' content IS matched
- [ ] #3 Tests cover both the negative (false-positive) and positive cases for lockfiles and .github
- [ ] #4 trusted-reviewers-drift.yml allowlist parsing converged with the runtime js-yaml parser (or documented why not)
- [ ] #5 pnpm --filter @ai-sdlc/pipeline-cli test + lint + format clean
<!-- AC:END -->
