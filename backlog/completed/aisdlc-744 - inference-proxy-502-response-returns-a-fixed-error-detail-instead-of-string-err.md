---
id: AISDLC-744
title: >-
  inference proxy 502 response returns a fixed error detail instead of String(err)
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - pipeline-cli/src/pipeline/inference-proxy.ts
  - pipeline-cli/src/pipeline/inference-proxy.test.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Code-scanning alert 158 (js/stack-trace-exposure) at `pipeline-cli/src/pipeline/inference-proxy.ts` around line 780: the 502 response returns `detail: safeDetail` built from `String(err)` through `sanitizeErrorMessage`. The sanitizer strips the credential but the raw error message still reaches the caller. Fix: return a fixed or code-based detail (for example `err.code ?? 'upstream_error'`), log the sanitized detail server-side, keep the existing credential redaction test and add one asserting the response detail never contains the upstream error message. The 500 handler near line 580 has the same shape and should get the same treatment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The 502 response detail is fixed or code-based and never contains the upstream error message, with tests.
- [x] The sanitized detail is logged server-side and the existing credential redaction test still passes.
- [ ] Code-scanning alert 158 reads `fixed` after merge.

## Final Summary

## Summary
The proxy's 500 and 502 handlers now return a fixed or code-based `detail` (`safeErrorCode`: allowlisted uppercase `err.code`, else `upstream_error` / `internal_error`) and log the credential-sanitized detail to stderr server-side.

## Changes
- `pipeline-cli/src/pipeline/inference-proxy.ts` (modified): add `safeErrorCode`; use it in the 500 and 502 handlers; log sanitized detail to stderr.
- `pipeline-cli/src/pipeline/inference-proxy.test.ts` (modified): response never contains upstream message/path; code-based detail; `safeErrorCode` unit test; credential-redaction test retained.

## Design decisions
- **Code allowlist** `/^[A-Z][A-Z0-9_]{0,63}$/`: lets callers distinguish ECONNREFUSED etc. without echoing message text.

## Verification
- `pnpm build` — clean
- `pnpm test` — inference-proxy 95 pass; full pipeline-cli run has 14 failures in verify-runtime, bin-invocation and TUI tests (files untouched by this change)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 reviews approved

## Follow-up
declined: stderr-log redaction and 500-path assertions, CR/LF stripping of the log line (reviewer minor/info suggestions, non-blocking)
