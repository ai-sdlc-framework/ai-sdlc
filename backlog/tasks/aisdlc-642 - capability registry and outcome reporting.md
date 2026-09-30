---
id: AISDLC-642
title: >-
  RFC-0049 section 9: capability registry, live/shadow/degraded outcome reporting and state file
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - capability-liveness
  - reference
  - observability
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/index.ts
  - docs/operations/fail-soft-at-the-adopter-boundary.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Several optional, model-backed capabilities shipped, passed every gate and then ran
their fallback path on every call for months without anyone noticing (RFC-0049
Motivation has the evidence). The fallback design was right. What was missing was any
record that the fallback, and only the fallback, was running. This task adds that
record: a registry of capabilities and a counter of how each one actually ran.
RFC-0049 sections 9.1 and 9.2.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`, section 9. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, 80% line coverage on new code.
  Scripts under `scripts/` use `node --test`.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **Registry** in a new directory `reference/src/capabilities/`, re-exported from
   `reference/src/index.ts`: `CapabilityDefinition` with `id`, `title`, `specifiedBy`
   (RFC id or source path), `fallback` (one sentence: what happens when degraded),
   `enable` (one sentence: how to turn it on); `registerCapability`, `getCapability`,
   `listCapabilities`; duplicate ids rejected.
2. **Built-in definitions** for the twelve capabilities in the RFC-0049 section 9.1
   table, with the ids exactly as written there.
3. **Outcome type:** `live`, `shadow`, `degraded`, as defined in RFC-0049 section 9.2.
4. **`reportCapabilityOutcome(id, outcome, opts)`** with optional `reason` and an
   `artifactsDir`. It updates `<artifactsDir>/_capabilities/state.json`: per
   capability, a count of each outcome, `firstLiveAt`, `lastLiveAt`, `lastShadowAt`,
   `lastDegradedAt` and `lastDegradedReason`. Writes are atomic (write to a temporary
   file, then rename) so concurrent processes cannot leave a torn file. An unknown id
   is recorded under its id and flagged `unregistered`. Any failure is swallowed: the
   function never throws and never changes the behaviour of its caller.
5. **`readCapabilityState(artifactsDir)`** returns one row per registered capability,
   with status `never-observed` for a capability that has no record, plus any
   unregistered ids found in the file.
6. **Status derivation** helper: the current status of a capability is the outcome of
   its most recent report; `never-observed` when there is none.

## Acceptance Criteria
- [ ] The registry, the twelve built-in definitions and the reporting functions exist under `reference/src/capabilities/` and are re-exported from `reference/src/index.ts`.
- [ ] The twelve built-in ids match the RFC-0049 section 9.1 table exactly (asserted against a literal list in a test).
- [ ] Reporting `degraded` then `live` for one capability yields counts of one each, a `lastLiveAt` later than `lastDegradedAt`, and a current status of `live`.
- [ ] A capability with no report reads back as `never-observed`.
- [ ] An unwritable artifacts directory, a corrupt state file and an unknown id each leave `reportCapabilityOutcome` returning normally without throwing.
- [ ] Twenty concurrent reports from separate processes leave a parseable state file whose counts sum to twenty.
- [ ] The state file contains no input text, only ids, counts, timestamps and reason strings.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
