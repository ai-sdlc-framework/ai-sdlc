---
id: AISDLC-633.3
title: >-
  RFC-0049 follow-up: the rejected provider option reason reaches evaluate.ts records and the doctor judgment check
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0049
  - judgment-layer
  - reference
  - orchestrator
dependencies:
  - AISDLC-633.1
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/openai-compatible-provider.ts
  - reference/src/judgment/evaluate.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
  - docs/operations/judgment-layer.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parked from the AISDLC-633.1 review (PR #1149), operator-approved for filing
2026-10-02. When the validator disables the provider, the reason (the offending key,
the https rule, the denylisted env name) is only visible through
`provider.isAvailable()`. `evaluate.ts` records the constant
`provider-unavailable` and `checkJudgmentLayer` in doctor never calls
`isAvailable()`, so an adopter with a rejected config sees a disabled layer and no
explanation.

## Conventions
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- Reasons are already sanitised by the provider (AISDLC-633.2); do not add config
  values to them here.
- Doctor stays read-only.

## Scope
1. `evaluate.ts` stores the provider's `isAvailable().reason` in
   `providerUnavailableReason` when one is given, falling back to the constant.
2. `checkJudgmentLayer` constructs the configured provider through the registry
   factory and, when `isAvailable()` is false, reports one condition naming the
   reason, with the same severity as the existing missing-key condition.
3. The runbook's disabled-reason row says where the reason appears (evaluation
   records and `doctor`).

## Acceptance Criteria
- [ ] With a config that sets an unknown option key, the evaluation record's `providerUnavailableReason` names that key.
- [ ] `doctor` on the same config reports a judgment-layer condition naming the key; on a valid config it reports none.
- [ ] A provider with no `isAvailable` reason still records `provider-unavailable`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
