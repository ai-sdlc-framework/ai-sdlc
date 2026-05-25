---
id: AISDLC-311
title: 'feat: RFC `requires:` field semantics — distinguish design-contract from runtime-code dependency'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-governance
  - documentation-quality
  - registry-hygiene
priority: medium
dependencies: []
blocked:
  reason: "Task body uses 'requires:' as a quoted FIELD NAME — the AISDLC-311 design surface itself. DoR gate-7 phrase detection mis-classifies these as ungrounded dependency references; they are descriptions of the feature being shipped, not task-level dependency declarations. Override per AISDLC-296 / RFC-0011 §13."
references:
  - spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md
  - spec/rfcs/README.md
  - scripts/check-rfc-docs.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `requires:` field in RFC frontmatter is ambiguous. RFC-0031 declares `requires: [RFC-0005, RFC-0008, RFC-0009, RFC-0029, RFC-0030]`, but its shipped `orchestrator/src/sa-scoring/revision-proposal.ts` has **zero runtime imports** from any of those RFCs' code (only imports `crypto.randomUUID`). Yet the field implies a hard dependency that would gate implementation order.

Surfaced during the 2026-05-16 RFC-0009 dependency investigation: the operator asked "have we shipped RFC-0009 since it's a dependency of RFC-0031?" — investigation showed RFC-0009 is `Ready for Review` (not shipped), but RFC-0031 shipped anyway because the `requires:` coupling was design-only, not code-only. Today there's no way to tell which from the frontmatter.

## Two distinct dependency kinds

1. **Design-contract dependency** — RFC A assumes the contract defined by RFC B. RFC A can ship without RFC B's implementation, as long as A's code doesn't import B's code. Example: RFC-0031 assumes DID schema shape from RFC-0009 but only takes abstract `IdentityClass + fieldPath` parameters; callers will provide the RFC-0009-resolved values once RFC-0009 ships.
2. **Runtime-code dependency** — RFC A's implementation imports RFC B's implementation. A cannot ship until B ships. Example: RFC-0035 Phase 5 (Stage C classifier) imports the shared classifier substrate from RFC-0024 Refit Phase 2.

The framework's `requires:` field today conflates both kinds, producing the false-positive "RFC-0031 requires RFC-0009 to ship first" implication that delayed nothing because nobody enforced it.

## Scope

### Frontmatter schema extension

Split the single `requires:` into two explicit fields:

```yaml
requires:                    # runtime-code dependency: implementations must ship in order
  - RFC-NNNN                 # A's code imports B's code
assumes:                     # design-contract dependency: A's design assumes B's contract
  - RFC-NNNN                 # A can ship without B's implementation
```

Existing `requires:` entries audited and rewritten — most likely re-classified as `assumes:`.

### Registry rendering

`spec/rfcs/README.md` registry table updated to show both columns. Operators reading the table can see at a glance: "this RFC needs X to ship first (requires) but only needs Y as a contract (assumes)."

### Linter

`scripts/check-rfc-docs.mjs` extended:
- `requires:` entries cross-checked against actual imports (when the target RFC declares `implementedBy:` paths)
- `assumes:` entries only need the target RFC to exist + be at `Ready for Review` or higher

### Migration

- Audit pass over all RFC frontmatter `requires:` declarations.
- Re-classify each entry into the new schema.
- Update the registry rendering.
- Backwards-compat: old `requires:` is deprecated but still accepted by the linter for one minor version, with a warning suggesting `assumes:` if no actual imports detected.

## Composition

- Composes with RFC-0035 Decision Catalog: every reclassification is a decision routed through the catalog.
- Composes with AISDLC-296 (DoR upstream-OQ gate) — when DoR checks RFC dependencies, only `requires:` should block dispatch; `assumes:` is documentation-only.
- Composes with AISDLC-297 (lifecycle promotion gate) — when promoting to `Implemented`, only `requires:` entries need to be at `Implemented`; `assumes:` entries only need to exist.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 RFC frontmatter schema extended with split `requires:` (runtime-code) + `assumes:` (design-contract) fields
- [ ] #2 All existing RFC frontmatter audited; entries re-classified into appropriate column
- [ ] #3 `spec/rfcs/README.md` registry table renders both columns
- [ ] #4 `scripts/check-rfc-docs.mjs` linter extended: `requires:` cross-checked against imports (with `implementedBy:` declared by target); `assumes:` only checks RFC exists at `Ready for Review` or higher
- [ ] #5 Backwards-compat: old `requires:` accepted for one minor version with deprecation warning suggesting `assumes:` if no actual imports
- [ ] #6 AISDLC-296 (DoR upstream-OQ gate) updated to only block on `requires:` entries, not `assumes:`
- [ ] #7 AISDLC-297 (lifecycle promotion gate) updated to only require shipped-status on `requires:` entries
- [ ] #8 Documentation in CLAUDE.md RFC section explains the two-field semantics
<!-- AC:END -->
