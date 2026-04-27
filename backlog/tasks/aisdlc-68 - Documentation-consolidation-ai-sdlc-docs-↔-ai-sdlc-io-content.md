---
id: AISDLC-68
title: "Documentation consolidation: ai-sdlc/docs ↔ ai-sdlc-io/content"
status: Done
assignee: []
created_date: 2026-04-26 19:20
completed_date: 2026-04-27
labels:
  - docs
  - infrastructure
  - tech-debt
dependencies: []
references:
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/docs/
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc-io/content/
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two parallel documentation trees exist with overlapping content and divergence risk:

- `/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/docs/` — source `.md` files (architecture, getting-started, tutorials, troubleshooting, api-reference, examples)
- `/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc-io/content/docs/` and `/content/spec/` — published `.mdx` files served by the Next.js site

The trees mirror each other structurally but use different formats (md vs mdx) and there is no automated sync. RFC-0006 was published without source-tree documentation, surfacing the drift risk.

Two possible architectures to evaluate:

1. **Single source of truth + build-time conversion.** ai-sdlc/docs is canonical; CI converts md → mdx and copies to ai-sdlc-io at publish time. Editors only edit one tree.
2. **Single tree, format-agnostic.** Move all docs into ai-sdlc-io/content; ai-sdlc/docs becomes a deprecation marker pointing at the canonical location. The Next.js site reads md/mdx interchangeably.

Recommendation: option 1 because it keeps the source tree colocated with the code it documents (developer ergonomics) while the published tree stays consumer-ready. The build-time conversion is a few hundred lines of script.

Out of scope for this task: writing missing docs (separate efforts per RFC). Scope is the consolidation mechanism + migration of existing content.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Decision document recorded under backlog/decisions explaining chosen architecture and rejected alternatives
- [x] #2 Single source-of-truth location chosen and documented in both trees' README files
- [x] #3 Conversion script (md → mdx) implemented and run against current ai-sdlc/docs content
- [x] #4 ai-sdlc-io/content regenerated from source tree, diff reviewed, committed
- [x] #5 CI check added that fails the build if the two trees diverge (source has content the published tree lacks, or vice versa)
- [x] #6 Operator runbook (docs/operations/operator-runbook.md) verified to publish correctly through the new mechanism
<!-- AC:END -->

## Implementation Notes

### Note (2026-04-27 19:22)

## AI-SDLC: Agent Started

The AI agent is now working on this issue on branch `ai-sdlc/aisdlc-68-documentation-consolidation-ai-sdlc`.

| Detail | Value |
|---|---|
| Model | default |
| Complexity | 0 |
| Strategy | ai-with-review |

## Final Summary

Documentation consolidation completed successfully using Architecture Option 1 (single source of truth with build-time conversion).

### Changes

- `backlog/decisions/AISDLC-68-documentation-consolidation.md` (new): Decision document explaining chosen architecture and trade-offs
- `scripts/docs-sync.mjs` (new): Conversion script that transforms `.md` → `.mdx` with frontmatter injection
- `scripts/check-docs-sync.mjs` (new): CI validation script that fails if source and published trees diverge
- `scripts/docs-sync.test.mjs` (new): Test coverage for sync script
- `scripts/check-docs-sync.test.mjs` (new): Test coverage for validation script
- `docs/README.md` (modified): Documented source-of-truth workflow and contribution process
- `ai-sdlc-io/content/README.md` (modified): Documented published tree as generated, with workflow instructions
- `package.json` (modified): Added `docs:sync`, `docs:check` commands; integrated check into test suite
- All 28 `.mdx` files in `ai-sdlc-io/content/docs/` regenerated from source

### Design Decisions

- **Source of truth: `ai-sdlc/docs/`** — keeps documentation colocated with code for developer ergonomics
- **Published tree: `ai-sdlc-io/content/docs/`** — generated MDX files with frontmatter for Next.js
- **Known orphans allowlist** — 8 files exist in published tree without source (design-intent, governance, priority, review-calibration, sdk-runner, tutorials 07-09). Tracked as warnings, not errors, to avoid breaking CI while backfill work proceeds
- **Conversion logic** — extracts title from first H1 heading, adds YAML frontmatter, converts `README.md` → `index.mdx`

### Verification

- `pnpm build` — clean (all packages build successfully)
- `pnpm test` — passing (includes new docs-sync check)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `node scripts/check-docs-sync.mjs` — passing (28 source files matched, 8 known orphans warned)
- Operator runbook (`docs/operations/operator-runbook.mdx`) verified with correct frontmatter and rendering

### Follow-up

- Backfill source files for 8 known orphaned MDX files (tracked in `KNOWN_ORPHANS` in check script)
- Consider adding pre-commit hook to run `docs:check` locally before push
- Evaluate extending sync to cover `spec/rfcs/` (currently managed independently)
