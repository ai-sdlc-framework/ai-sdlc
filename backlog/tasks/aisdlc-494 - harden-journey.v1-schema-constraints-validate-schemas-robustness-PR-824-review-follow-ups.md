---
id: AISDLC-494
title: >-
  harden journey.v1 schema constraints + validate-schemas robustness (PR #824
  review follow-ups)
status: To Do
assignee: []
created_date: '2026-06-01 17:18'
labels:
  - rfc-0018
  - schema
  - tech-debt
  - review-follow-up
dependencies: []
references:
  - 'https://github.com/ai-sdlc-framework/ai-sdlc/pull/824'
  - spec/schemas/journey.v1.schema.json
  - reference/src/core/validate-schemas.ts
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Non-blocking follow-ups surfaced by the 3 reviewers on PR #824 (AISDLC-465, RFC-0018 Phase 1 journey schema). All were minor/suggestion severity — the PR merged with them deferred per the review-severity policy.

## Findings to address

### journey.v1.schema.json — encode prose constraints as JSON Schema (code-reviewer, 2 minor)
1. `completionCriteria.target` is described as "Required when kind=terminal-success-state" but no `if/then` conditional enforces it — a doc with `kind=terminal-success-state` and no `target` passes validation silently. Add an `if/then` requiring `target` when `kind` is `terminal-success-state`.
2. `states[]` description says "at least 1 MUST have terminal:true AND successState:true" but no `contains` constraint enforces it — a journey where all states are non-terminal passes. Add a `contains` schema asserting ≥1 terminal success state.

### journey.v1.schema.json — defense-in-depth bounds (security-reviewer, suggestion)
3. No `maxItems` on states/transitions/successMetrics/designImperatives and no `maxLength` on transition from/to/trigger strings. The soft/hard count limits documented in journey-config.v1 (hardLimit 50 journeys, 100 states) live in application code, not the instance schema. Encode them as `maxItems`/`maxLength` so the schema is self-defending if a journey doc is ever fed from an untrusted source. (Not currently exploitable — journey declarations are maintainer-authored Soul DID config.)

### reference/src/core/validate-schemas.ts (security + test, suggestion)
4. The idempotency guard `if (!ajv.getSchema(schema.$id ?? file))` keys on `$id`, so two committed files sharing a `$id` would silently skip the second file's well-formedness check. Add an assertion that `$id`s are unique across all schema files (catch accidental collisions at build time).
5. The two-pass idempotent registration fix (`ajv.getSchema(id) ?? ajv.compile(schema)`) has no direct unit regression test — it's only exercised end-to-end via the CI validate-schemas step. Add a hermetic test that registers schemas twice in one process (or mocks a duplicate-$id) to pin the regression permanently.
6. Add a comment at the `validate({})` call in Pass 2 noting the validation result is intentionally ignored (goal is compilation/$ref-resolution exceptions only) so future readers don't mistake it for a missing error check.

## Context
Surfaced 2026-06-01 during the reconcile of PR #824's CI fix. None block correctness; items 1–2 are the highest-value (silent schema gaps). Item 4 generalizes the security-reviewer's $id-confusion observation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 journey.v1.schema.json enforces 'target required when kind=terminal-success-state' via an if/then conditional, with a test proving a missing target now fails validation
- [ ] #2 journey.v1.schema.json enforces '>=1 terminal success state' via a contains constraint, with a test proving an all-non-terminal journey now fails validation
- [ ] #3 journey.v1.schema.json adds maxItems on states/transitions/successMetrics/designImperatives and maxLength on transition string fields, aligned with journey-config.v1 documented limits
- [ ] #4 validate-schemas.ts asserts $id uniqueness across all schema files and fails the build on a duplicate $id
- [ ] #5 A hermetic regression test pins the validate-schemas idempotent-registration fix (double-registration in one process does not throw)
- [ ] #6 pnpm -C reference validate-schemas + full reference suite + lint + format pass
<!-- AC:END -->
