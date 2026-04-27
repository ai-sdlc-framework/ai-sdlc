# Decision: Documentation Consolidation Architecture

**Issue:** AISDLC-68  
**Date:** 2026-04-27  
**Status:** Accepted

## Context

Two parallel documentation trees exist with overlapping content and divergence risk:

- `/ai-sdlc/docs/` — source `.md` files (architecture, getting-started, tutorials, troubleshooting, api-reference, examples)
- `/ai-sdlc-io/content/docs/` and `/content/spec/` — published `.mdx` files served by the Next.js site

The trees mirror each other structurally but use different formats (md vs mdx) and there is no automated sync. RFC-0006 was published without source-tree documentation, surfacing the drift risk. Manual synchronization is error-prone and creates maintenance burden.

## Decision

**We choose Architecture Option 1: Single source of truth + build-time conversion.**

- **Source of truth:** `/ai-sdlc/docs/` (markdown files)
- **Published tree:** `/ai-sdlc-io/content/docs/` (mdx files, generated)
- **Conversion:** Automated script converts `.md` → `.mdx` with frontmatter injection
- **Enforcement:** CI check fails if published tree diverges from source

## Alternatives Considered

### Option 2: Single tree, format-agnostic
Move all docs into `/ai-sdlc-io/content/`; `/ai-sdlc/docs/` becomes a deprecation marker.

**Rejected because:**
- Breaks developer ergonomics: documentation is no longer colocated with the code it documents
- Forces developers to context-switch to a different repository to read/update docs
- Next.js workspace becomes a dependency for all doc contributions
- Harder to maintain versioning alignment between code and docs

## Implementation

### Conversion Script
Located at: `scripts/docs-sync.mjs`

Transforms markdown to mdx by:
1. Extracting first H1 heading as title
2. Injecting YAML frontmatter with title
3. Preserving all content structure
4. Copying to corresponding path in ai-sdlc-io

### CI Check
Located at: `scripts/check-docs-sync.mjs`

Validates that:
1. Every `.md` file in `/ai-sdlc/docs/` has a corresponding `.mdx` in `/ai-sdlc-io/content/docs/`
2. Content matches (ignoring frontmatter differences)
3. No orphaned files exist in published tree

Runs as part of the test suite.

### Migration Process
1. Run conversion script to regenerate all mdx files from source md
2. Review diff to ensure no regressions
3. Update both README files to document the new workflow
4. Add CI check to prevent future drift

## Consequences

### Positive
- Single source of truth eliminates drift risk
- Documentation colocated with code improves developer experience
- Automated conversion removes manual sync burden
- CI enforcement prevents accidental divergence
- Spec/RFC files can remain in ai-sdlc-io (not duplicated in source tree)

### Negative
- Adds build step to documentation workflow
- Published tree is now generated (cannot be edited directly)
- Conversion script becomes critical infrastructure

### Mitigations
- Conversion script is simple and testable (few hundred lines)
- CI check provides safety net
- README files clearly document workflow
- Script errors are caught early in CI

## Verification

- [ ] Conversion script handles all existing docs without errors
- [ ] Generated mdx files render correctly in Next.js site
- [ ] Operator runbook publishes correctly
- [ ] CI check catches intentional divergence
- [ ] README files accurately document workflow
