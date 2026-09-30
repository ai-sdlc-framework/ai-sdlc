---
id: AISDLC-647
title: >-
  RFC-0049 OQ-6: runtimeEvidence in the RFC schema, evidence required for Signed Off to Implemented, retroactive annotations
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - capability-liveness
  - spec
  - rfc-process
  - ci
dependencies:
  - AISDLC-642
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - spec/schemas/rfc.schema.json
  - scripts/check-rfc-lifecycle-transitions.mjs
  - scripts/check-rfc-lifecycle-transitions.test.mjs
  - scripts/check-rfc-docs.mjs
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Four RFCs are marked `Implemented` while a model-backed capability each one specifies
has never run in this repository. The lifecycle gate checks the order of the ladder and
asks for no evidence. This task adds the evidence field, makes promotion to
`Implemented` require it, and corrects the record for the four. RFC-0049 section 9.4
and the OQ-6 resolution (annotate per capability; lifecycles are not rolled back).

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
1. **Schema:** add optional `runtimeEvidence` to `spec/schemas/rfc.schema.json`: a
   list of entries with `capability` (string), `status` (`live`, `shadow`, `degraded`,
   `not-applicable`), `evidence` (string), `date` (ISO date) and optional `owner`
   (tracked-work id). Regenerate any generated schema output and run the RFC test
   suite (`pnpm rfc:test`).
2. **Promotion rule** in `scripts/check-rfc-lifecycle-transitions.mjs`: a transition
   from `Signed Off` to `Implemented` is refused unless `runtimeEvidence` is present in
   the after-content and every entry is `live` or `not-applicable`. An empty list is
   accepted and means the RFC specifies no optional capability. The existing audited
   operator override applies to this rule exactly as to ladder skips, and writes the
   same audit entry.
3. **Linter warning** in `scripts/check-rfc-docs.mjs`: for every RFC at lifecycle
   `Implemented` with a `degraded` or `shadow` entry, print one warning line naming
   the RFC, the capability and the owner. Warnings do not fail the check. An entry
   whose `capability` is not one of the ids in the RFC-0049 section 9.1 table, and is
   not declared by a Judgment Catalog definition, is a failure.
4. **Retroactive blocks** (OQ-6), using the evidence recorded in RFC-0049 Motivation
   and dated 2026-09-30. Lifecycles stay `Implemented`; bump each RFC's `updated` date
   and add one Revision History row; change nothing else in these RFCs.
   - the Definition-of-Ready RFC (number 0011): `dor.stage-b` degraded, owner
     AISDLC-636.
   - `spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md`:
     `estimation.class-assignment` degraded, owner AISDLC-635; `estimation.stage-b`
     degraded, no owner.
   - `spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md`: the four `classifier.*`
     capabilities degraded, owner AISDLC-634.
   - `spec/rfcs/RFC-0035-decision-catalog-operator-routing.md`:
     `decisions.stage-c-recommendation` degraded, owner AISDLC-634;
     `decisions.stage-b-signals` degraded, owner AISDLC-635.
5. **Process docs:** document `runtimeEvidence` and the promotion rule in
   `spec/rfcs/README.md` (frontmatter convention and lifecycle sections) and add the
   field, commented, to the RFC template file in `spec/rfcs/`.

## Acceptance Criteria
- [ ] `rfc.schema.json` accepts a well-formed `runtimeEvidence` list and rejects an entry with an unknown `status` or a missing `capability`.
- [ ] The lifecycle gate refuses `Signed Off` to `Implemented` when `runtimeEvidence` is absent, and when any entry is `degraded` or `shadow`.
- [ ] The lifecycle gate allows the transition with an empty list, and with every entry `live` or `not-applicable`.
- [ ] The operator override marker (both locations, allowlisted operator) permits the transition with a degraded entry and writes an audit entry.
- [ ] Transitions other than `Signed Off` to `Implemented` behave exactly as before (existing tests unchanged and passing).
- [ ] `check-rfc-docs.mjs` prints one warning per non-live entry on an `Implemented` RFC, exits zero for warnings, and fails for an unknown capability id.
- [ ] The four RFCs carry the `runtimeEvidence` blocks listed above, remain at lifecycle `Implemented`, and have a Revision History row for the change.
- [ ] `spec/rfcs/README.md` and the RFC template file document the field and the promotion rule.
- [ ] `pnpm rfc:test && pnpm rfc:check` pass.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
