---
id: AISDLC-68
title: 'Documentation consolidation: ai-sdlc/docs ↔ ai-sdlc-io/content'
status: Done
assignee: []
created_date: '2026-04-26 19:20'
updated_date: '2026-04-27 23:09'
labels:
  - docs
  - infrastructure
  - tech-debt
dependencies: []
references:
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/docs/
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc-io/content/
  - >-
    /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
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
- [ ] #5 CI check added that fails the build if the two trees diverge (source has content the published tree lacks, or vice versa)
- [x] #6 Operator runbook (docs/operations/operator-runbook.md) verified to publish correctly through the new mechanism
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Established `ai-sdlc/docs` as the single source of truth for user-facing documentation. Added md → mdx conversion script, divergence checker wired into `pnpm test`, reverse-migrated 8 orphaned mdx pages back to source, and regenerated the entire `ai-sdlc-io/content/docs` published tree. Architecture decision recorded.

## Changes

- `backlog/decisions/AISDLC-68-documentation-consolidation.md` (new): chosen architecture (option 1 — source colocated with code, build-time conversion) + rejected alternatives
- `docs/README.md` (modified): documents source-of-truth role + sync flow
- `docs/api-reference/{design-intent,governance,priority,review-calibration,sdk-runner}.md` (new): reverse-migrated from sibling-only mdx
- `docs/tutorials/{07-workflow-patterns,08-claude-code-plugin,09-review-calibration}.md` (new): reverse-migrated from sibling-only mdx
- `scripts/docs-sync.mjs` (new): md → mdx converter (frontmatter extraction, link rewriting, conservative fence handling)
- `scripts/check-docs-sync.mjs` (new): divergence checker; pass when sibling missing (CI-friendly), fail when source/published trees diverge
- `scripts/docs-sync.test.mjs` (new): 12 test cases on the conversion primitives
- `package.json` (modified): adds `docs:sync`, `docs:check`, `docs:test` scripts; chains `docs:test && docs:check` after `pnpm -r test`

## External (sibling repo) changes

36 files in `../ai-sdlc-io/content/docs/`: api-reference, tutorials, README/index pages, operations runbook, troubleshooting, architecture, prd. Will land in a parallel sibling PR.

## Design decisions

- **Single source of truth in `docs/`** — colocates docs with code (devs editing one tree). Rejected option 2 (single tree in sibling) because it splits source/code across repos.
- **CI check is a script in `scripts/`, not a workflow yaml** — `.github/workflows/**` is in agent blocked-paths. The script is wired into `pnpm test`; the human adds a one-line `.github/workflows/docs-sync-check.yml` invoking `pnpm docs:check` on PR (Acceptance Criterion #5 partial; documented in PR body).
- **Soft-pass when sibling repo absent** — CI may run without `../ai-sdlc-io/` cloned; the checker warns and exits 0. Catches drift locally; future workflow can opt into hard-fail via env var.
- **Preserved hand-curated index.mdx files** in sibling — Fumadocs synthesizes navigation pages that have no source-tree counterpart; the checker tolerates them via an explicit allowlist.

## Verification

- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (⚠ INDEPENDENCE NOT ENFORCED — codex unavailable, fell back to claude-code): 0 critical, 0 major, 4 minor, 6 suggestions

## Follow-up

- Human adds `.github/workflows/docs-sync-check.yml` invoking `pnpm docs:check` (AC #5 completion). Either directly or via a small follow-up PR.
- Address review suggestions: minor doc/script wording drift (decision doc says "README.md → index.mdx" but script preserves both), env-var override for hard-fail in CI, frontmatter round-tripping footgun, fence-detection edge cases. None block merge.
- 4 hand-curated `content/docs/**/index.mdx` files in the sibling were restored from a prior dirty-state attempt — sibling PR should review whether to keep that restore or land a fresh version.
- Sibling repo also contains pre-existing untracked `content/spec/rfcs/`, `content/README.md`, and a stray `docs/` directory left from earlier attempts; sibling-PR creation in Step 12 must NOT `git add -A` — only the 36 files in the developer's `filesChangedExternal` list.
<!-- SECTION:FINAL_SUMMARY:END -->
