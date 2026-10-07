---
id: AISDLC-744
title: >-
  inference proxy 502 response returns a fixed error detail instead of String(err)
status: To Do
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

- [ ] The 502 response detail is fixed or code-based and never contains the upstream error message, with tests.
- [ ] The sanitized detail is logged server-side and the existing credential redaction test still passes.
- [ ] Code-scanning alert 158 reads `fixed` after merge.
