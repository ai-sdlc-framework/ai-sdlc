---
id: AISDLC-655.1
title: >-
  RFC-0050: live smoke test of the reviewer replay sandbox with the real claude CLI
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
dependencies:
  - AISDLC-655
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/replay-run.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The replay sandbox was built and tested without a live model call. Run it once against the installed claude CLI and record the results: that the reviewer agent still resolves with user-only settings sources, that authentication still works under the scrubbed environment for a subscription login and for an API key, that the variable disabling CLAUDE.md loading has any effect (or replace it with a verified mechanism), and that no commit-supplied configuration is loaded. Adjust the sandbox flags if any of these fail.

Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A replay of one corpus item completes against the real CLI with the sandbox on and produces a block or approve outcome.
- [ ] Authentication works under the scrubbed environment for a subscription login and for an API key, recorded in the task notes.
- [ ] The effect of the CLAUDE.md-disabling variable is verified, or the sandbox uses a verified mechanism instead.
- [ ] A commit carrying a project hook and a project agent definition does not run either during replay.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
