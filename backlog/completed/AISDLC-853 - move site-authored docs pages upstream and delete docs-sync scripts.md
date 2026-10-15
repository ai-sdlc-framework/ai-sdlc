---
id: AISDLC-853
title: Move the 15 site-authored ai-sdlc.io pages into docs/ and spec/, add description frontmatter, delete the dead docs-sync scripts
status: Done
assignee: []
created_date: '2026-10-13'
labels: [docs, docs-platform]
dependencies: []
references: [docs/concepts/zero-trust-untrusted-pr-verification.md, docs/concepts/untrusted-contributor-verification.md, docs/whitepapers/proof-of-execution.md, scripts/docs-sync.mjs, scripts/check-docs-sync.mjs, scripts/docs-sync.test.mjs, package.json, docs/README.md]
priority: high
dispatchable: true
---

## Description

Decision DEC-0001 in the `ai-sdlc-io` repo: the website becomes a display layer that builds from this repository at a pinned commit (site tasks IO-1 to IO-5). Every page the site shows must therefore live here. Fifteen pages were written in the site repo and have no upstream source: 14 under `content/docs/concepts/` (index, autonomous-orchestrator, cross-harness-review, dor-gate, judgment-layer, operator-tui, per-repo-governance, proof-of-execution, reviewer-independence, session-hierarchy, staged-review, two-tier-pipeline, usage-ledger-model-routing, zero-trust-pr-verification), `content/spec/design-intent.mdx` and `content/whitepapers/untrusted-contributor-verification.mdx`. They are read from the sibling checkout at `../ai-sdlc-io/` on `main` (read only; no write to that repo).

The two scripts `scripts/docs-sync.mjs` and `scripts/check-docs-sync.mjs` implement a push-style sync that contradicts the site's own script and is a no-op in CI (`check-docs-sync.mjs` exits 0 when `../ai-sdlc-io` is absent). Under the pull model they have no role. Deleting them removes `docs:sync`, `docs:check` and `docs:test` and the `pnpm docs:check` step inside the root `test` script.

## Scope

1. Concepts: copy the 14 site concept pages into `docs/concepts/` as `.md` with YAML frontmatter (`title`, `description`). The site's `zero-trust-pr-verification` overlaps `docs/concepts/zero-trust-untrusted-pr-verification.md`; fold the site text into the existing file and do not create a duplicate. The site's `index.mdx` becomes `docs/concepts/README.md`. Keep the existing 7 concept files; give each a `title`/`description` frontmatter so the site renders them uniformly.
2. Spec: add `spec/design-intent.md` from the site's `content/spec/design-intent.mdx` (233 lines, DesignIntentDocument normative text); link it from `spec/README.md` or `spec/spec.md` where the DID is referenced.
3. Whitepaper: add `docs/whitepapers/untrusted-contributor-verification.md` with the site's frontmatter (`title`, `description`, `subtitle`, `audience`, `version`, `date`, `author`, `reference`). Add `description` to `docs/whitepapers/proof-of-execution.md` (the site's short title "Proof of Execution" becomes `title`; move the long form into `subtitle` if not already there).
4. Convert MDX-only syntax in the moved pages back to plain markdown (the site's pages contain none per the audit; verify with a grep for `import ` and `<` JSX outside code fences).
5. Delete `scripts/docs-sync.mjs`, `scripts/check-docs-sync.mjs`, `scripts/docs-sync.test.mjs`; remove `docs:sync`, `docs:check`, `docs:test` from `package.json` and the `pnpm docs:check` step from the root `test` script. Update `docs/README.md`, which names `docs-sync.mjs` as the canonical sync, to say the site pulls this repo at a pinned commit (one paragraph, link to the `ai-sdlc-io` README).
6. Fix the links inside the moved pages so they are relative paths that resolve in this repo (for example `../../spec/rfcs/RFC-0052-....md`), not site routes.

Out of scope: navigation files (AISDLC-854); content corrections to existing pages (AISDLC-855).

## Acceptance Criteria

- [ ] Every one of the 15 pages has a counterpart under `docs/concepts/`, `spec/` or `docs/whitepapers/` with frontmatter `title` and `description`, and `docs/concepts/` has exactly one zero-trust page.
- [ ] `grep -rn "docs-sync\|docs:check\|check-docs-sync" package.json scripts docs .github` returns nothing.
- [ ] `pnpm test` at the root passes without the `docs:check` step.
- [ ] Every relative link in the moved pages resolves to a file in this repo (checked with a one-off script in the PR description or the existing `backlog-drift` dead-ref check extended to the files).
- [ ] `docs/README.md` no longer references `docs-sync.mjs`.
