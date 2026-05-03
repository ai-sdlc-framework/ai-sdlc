---
id: AISDLC-109
title: >-
  spec/rfcs/ has duplicate id: RFC-0003 — renumber
  product-first-implementation-strategy.md
status: To Do
assignee: []
created_date: '2026-05-01 05:47'
labels:
  - docs
  - rfc-process
  - footgun
  - spec-hygiene
dependencies: []
references:
  - spec/rfcs/RFC-0003-infrastructure-adapters.md
  - scripts/check-rfc-docs.mjs
priority: low
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0003-product-first-implementation-strategy.md
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-05-01 during AISDLC-69.6 code review (PR #130). Two files in `spec/rfcs/` both declare `id: RFC-0003` in their frontmatter:

- `spec/rfcs/RFC-0003-infrastructure-adapters.md`
- `spec/rfcs/RFC-0003-product-first-implementation-strategy.md`

## Risk

- Citations in docs/ that reference "RFC-0003" by ID alone are ambiguous
- Any tool resolving RFCs by `id` (vs by file path) will pick whichever the filesystem walk returns first — non-deterministic
- `scripts/check-rfc-docs.mjs` (AISDLC-69.3 gate) walks the directory; a future `requiresDocs` config keyed on `id: RFC-0003` would conflate the two RFCs

## What changes

Renumber `RFC-0003-product-first-implementation-strategy.md` to a vacant RFC ID:

1. Pick the next available ID (likely RFC-0013+ or whichever slot is next based on `spec/rfcs/` audit)
2. Rename the file: `git mv spec/rfcs/RFC-0003-product-first-implementation-strategy.md spec/rfcs/RFC-NNNN-product-first-implementation-strategy.md`
3. Update the file's frontmatter `id:` field to match the new RFC number
4. Update any cross-references in other RFCs / docs that linked to the old name (`grep -rn "RFC-0003-product-first" .` then update each match)
5. Verify `pnpm rfc:check` still clean
6. Verify no broken links via doc-validation

## Acceptance Criteria

1. `spec/rfcs/` contains exactly ONE file with `id: RFC-0003` (the infrastructure-adapters one — chosen because it's already cited by AISDLC-69.6's PR #130)
2. The product-first-implementation-strategy RFC has a new unique ID + matching filename
3. All cross-references updated (no dangling links to the old filename)
4. `pnpm rfc:check` clean
5. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## Why now

PR #130 (AISDLC-69.6) just shipped citations to RFC-0003 by name; choosing infrastructure-adapters is now the de-facto canonical RFC-0003. Renumbering the other before it accumulates more citations is the cheaper path.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Renumbered duplicate `RFC-0003-product-first-implementation-strategy.md` → `RFC-0013-product-first-implementation-strategy.md`. Updated frontmatter `id`, H1 heading, and all cross-references (RFC-0004 link, README index + operator-process citation, AISDLC-69.6 backlog task historical note). `spec/rfcs/` now contains exactly one file with `id: RFC-0003` (the canonical infrastructure-adapters one).

## Why RFC-0013
Audit of `spec/rfcs/` showed taken slots {0001, 0002, 0003, 0004, 0005, 0006, 0008, 0010}. Slots 0007 + 0009 reserved/withdrawn (folded into 0006/0008). Slots 0011 + 0012 referenced as future work — 0011 folded into RFC-0010 (DB isolation phase), 0012 reserved for the two-tier-pipeline-architecture RFC referenced by `pipeline-cli/README.md` and `CLAUDE.md`. So 0013 is the first genuinely free slot.

## AC status
- ✓ All 5 ACs met (modulo pre-existing dogfood/runner/exports.test.ts flake — unrelated, passes in isolation)

## Verification
- `pnpm rfc:check` clean (8 RFCs walked)
- `pnpm build && pnpm lint && pnpm format:check` clean
- `pnpm test` had pre-existing dogfood flake (5s timeout under parallel load); passes when run in isolation
- `grep -rn 'RFC-0003-product-first' .` returns only the historical note in AISDLC-109's own task body + AISDLC-69.6's task (intentional)
- 3 reviews approved: code 0c/0M/1m/1s; test 0c/0M/0m/0s; security 0c/0M/0m/0s
- ⚠ INDEPENDENCE NOT ENFORCED

## Follow-up (deferred from review)
- README §reserved-slots note only mentions RFC-0007 + RFC-0009; extend to clarify RFC-0011 + RFC-0012 status (RFC-0012 heavily cited but no spec file)
- README cosmetic: blank line between the two reserved/historical notes for proper Markdown blockquote rendering
<!-- SECTION:FINAL_SUMMARY:END -->
