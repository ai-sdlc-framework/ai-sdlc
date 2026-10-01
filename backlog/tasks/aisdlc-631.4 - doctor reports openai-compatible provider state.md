---
id: AISDLC-631.4
title: >-
  RFC-0049 follow-up: doctor judgment check reports the openai-compatible provider and its shadow cap
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - doctor
dependencies:
  - AISDLC-631
  - AISDLC-633
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - orchestrator/src/cli/commands/doctor-checks.ts
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Reviewer minor: the doctor judgment check reports the Jev provider but not the
`openai-compatible` one, and does not say that judgments on it are capped at `shadow`.

## Scope
Extend the doctor judgment check in `orchestrator/src/cli/commands/doctor-checks.ts`: name the configured provider, its base URL host
(never the key), whether it is loopback, and, for a provider with
`calibratedProbabilities: false`, state that every judgment runs in `shadow`.

## Acceptance Criteria
- [ ] With `spec.provider: openai-compatible`, the check lists the provider, host, loopback status and the shadow cap.
- [ ] No output line contains the API key value.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
