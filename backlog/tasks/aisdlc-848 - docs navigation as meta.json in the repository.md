---
id: AISDLC-848
title: Own the docs site navigation in-repo via fumadocs meta.json files under docs/ and spec/
status: To Do
assignee: []
created_date: '2026-10-13'
labels: [docs, docs-platform]
dependencies: [AISDLC-847]
references: [docs/README.md, docs/operations/README.md, docs/api-reference/README.md, docs/tutorials/README.md]
priority: high
dispatchable: true
---

## Description

With the site pulling this repo (DEC-0001 in `ai-sdlc-io`), the only navigation the site has, seven `meta.json` files under its `content/` tree, is being deleted (site task IO-2). The site will read fumadocs `meta.json` files from this repository instead (site task IO-3), so section order, separators and which pages are public become an editorial decision made here, next to the content. This task adds those files, reproducing today's public navigation so the change is a pure move of responsibility, not a change in scope. Expanding what is published (for example `docs/operations/`, 95 runbooks, or `spec/rfcs/`) is a follow-up editorial decision; until then those directories stay unlisted and the site's link rewriter sends links to them to GitHub.

Today's site navigation to reproduce (from `ai-sdlc-io/content/**/meta.json` on `main`): `docs/meta.json` with separators `---Getting Started---` etc. and pages `index`, `getting-started`, `concepts`, `tutorials`, `api-reference`, `rfc-registry`, `architecture`, `troubleshooting`, plus `prd-claude-code-native-integration`, which is currently orphaned and should be listed under a "Reference" separator; `docs/getting-started/meta.json`, `docs/concepts/meta.json`, `docs/tutorials/meta.json`, `docs/api-reference/meta.json` with explicit `pages` arrays; `spec/meta.json` with `title: Specification` and `pages: [primer, spec, policy, autonomy, agents, adapters, design-intent, metrics, glossary]`; `docs/whitepapers/meta.json` with both whitepapers.

## Scope

1. Add the seven `meta.json` files listed above, fumadocs format (`title`, `pages`, `---Separator---` strings, `...` catch-all where the directory should show every page).
2. `docs/concepts/meta.json` lists the 14 moved pages plus the 7 pre-existing concept files in a sensible order (shipped-feature overviews first, then patterns).
3. `docs/README.md`: fix the "Sections" table (add Concepts and White papers; the tutorials count says 5 and there are 15 files) so the landing page the site renders at `/docs` matches the sidebar.
4. A small `scripts/check-docs-nav.mjs` run by root `pnpm test`: every `pages` entry in every `meta.json` resolves to a file or directory, and every `.md` file in a directory that has a `meta.json` without `...` is either listed or named in an `exclude` list. Keeps the nav from drifting the way `content/` did.

Out of scope: publishing `docs/operations/` or RFC pages; changing any page body.

## Acceptance Criteria

- [ ] Seven `meta.json` files exist at the paths above and validate with `scripts/check-docs-nav.mjs`; `pnpm test` runs that check.
- [ ] Order and separators match the site's `content/docs/meta.json` and `content/spec/meta.json` on `ai-sdlc-io` `main`, with `prd-claude-code-native-integration` now listed.
- [ ] `docs/README.md` Sections table lists Concepts and White papers and gives the correct tutorial count.
- [ ] No `meta.json` lists a page outside `docs/` or `spec/`.
