---
id: AISDLC-165
title: 'RFC numbering governance + registry index + reserve RFC-0017/0018'
status: Done
assignee: []
created_date: '2026-05-02'
labels:
  - spec
  - governance
  - rfc-process
dependencies: []
references:
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0001-template.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The RFC list has grown to 16 (RFC-0001 through RFC-0016) and we're starting to dispatch parallel RFC work. Without a single source of truth for RFC numbers + governance rules about claiming them, two PRs can race for the same number (the RFC-0003 collision resolved by AISDLC-109 already showed how confusing this gets) and the RFC-0007 / RFC-0009 "reserved or withdrawn?" status was inferred from a footnote rather than a structured registry row.

This task establishes the registry as the canonical claim mechanism: one table, every shipped + in-flight + withdrawn + reserved number, with explicit governance rules about how to claim or reserve. It also reserves RFC-0017 and RFC-0018 as placeholders for the In-Shard Variant Pattern and In-Shard Journey Pattern carved out of RFC-0009 per OQ-3 resolution.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 RFC index covers all 16 current RFCs (RFC-0001 through RFC-0016) plus the 2 new reservations (RFC-0017, RFC-0018), pulled from each file's frontmatter
- [x] #2 Governance rules in `spec/rfcs/README.md` explain how to claim a number (PR adds file + registry row, OR PR adds registry row marked Reserved); single source of truth named explicitly
- [x] #3 Drift check exits 0 (`backlog-drift validate`)
- [x] #4 `CLAUDE.md` RFCs section updated to point future sessions at the registry for number lookup
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Single-file edit to `spec/rfcs/README.md` (replaced the old `## Index` section with a new `## Claiming an RFC number (AISDLC-165)` governance section + a `## Registry` table) plus a one-paragraph addition to the `## RFCs` section in `CLAUDE.md`.

- **Registry schema**: `# | Title | Status | Lifecycle | Author | File | Notes`. Pulled `status`, `lifecycle`, `author` from each RFC's YAML frontmatter via `awk`/`head`. Added a `**Next available number:** RFC-0019.` footer so the next claim doesn't have to scan all rows.
- **RFC-0009 row**: file isn't on `main` yet (lives on branch `rfc/0009-tessellated-design-intent-documents`), so the row's File column says "in-flight" rather than linking. Notes column points at the OQ-3 carve-out provenance for RFC-0017/0018.
- **Reservations**: RFC-0017 (In-Shard Variant Pattern) and RFC-0018 (In-Shard Journey Pattern) added with `Status: Reserved`, `Lifecycle: Placeholder`, no file link, Notes citing OQ-3 resolution.
- **Governance**: explicit four-state model (Active / Reserved / Withdrawn / Template) with rules for claiming, reserving, releasing, and the no-recycle policy (RFC-0003 collision is the precedent).
- **CLAUDE.md**: added a "Number lookup" paragraph under the existing RFCs section directing future sessions to read the Registry's "Next available number" line rather than scan the filesystem (filesystem misses reservations).

Decided to extend the README rather than create a separate `INDEX.md` — the README already had an Index section and splitting would create two-source-of-truth drift. The README is now the single canonical registry.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
Established `spec/rfcs/README.md` as the canonical RFC number registry (single source of truth) with explicit governance rules for claiming and reserving numbers, completed the index by adding the four previously-missing entries (RFC-0007, RFC-0009, RFC-0015, RFC-0016) plus a richer schema (Author + File + Notes columns), and reserved RFC-0017 (In-Shard Variant Pattern) and RFC-0018 (In-Shard Journey Pattern) as placeholders carved out of RFC-0009 per OQ-3 resolution.

## Changes
- `spec/rfcs/README.md` (modified): replaced the old `## Index` section with a new `## Claiming an RFC number (AISDLC-165)` governance section + a `## Registry` table. Schema is `# | Title | Status | Lifecycle | Author | File | Notes`. All 16 existing RFCs included with metadata pulled from frontmatter; RFC-0017 + RFC-0018 added as Reserved / Placeholder rows. Footer line `Next available number: RFC-0019` added.
- `CLAUDE.md` (modified): added a Number lookup paragraph under the existing RFCs section pointing future sessions at the Registry's "Next available number" line.

## Design decisions
- **One file, not two**: extended the README rather than spinning up a separate `INDEX.md`. The README already had an Index; splitting it would create two-source-of-truth drift the moment a new RFC lands and the author updates only one.
- **No recycling of withdrawn numbers**: kept the explicit no-recycle rule (RFC-0003 collision precedent) so reviewers reading old PRs aren't confused by two different RFCs at the same number.
- **`Status: Reserved` + `Lifecycle: Placeholder`**: re-used the existing column schema rather than introducing a new "reservation" sub-table. Reserved entries fit the same row layout; the only difference is the File column says `(none yet)` and Notes explains the intended scope.
- **CLAUDE.md "do not scan the filesystem" hint**: future Claude sessions might naturally `ls spec/rfcs/` to find the next number, missing reservations that have no file. The added paragraph forecloses that pattern.

## Verification
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `backlog-drift validate` — clean

## Follow-up
(none) — when the In-Shard Variant Pattern and In-Shard Journey Pattern designs mature, the AISDLC-165 reservations are promoted in place by amending their rows (File + Author + Lifecycle) in a follow-on PR.
