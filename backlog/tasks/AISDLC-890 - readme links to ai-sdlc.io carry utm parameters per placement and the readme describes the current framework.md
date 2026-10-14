---
id: AISDLC-890
title: 'docs(readme): every ai-sdlc.io link in README.md carries UTM parameters per placement, and the README describes the current framework'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [docs, readme, analytics, velocity]
dependencies:
  - AISDLC-853
references:
  - README.md
  - scripts/check-claude-md-size.test.mjs
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Context

Operator request 2026-10-14 (relayed from the ai-sdlc.io planner, confirmed in the planner session): traffic reaching ai-sdlc.io from the GitHub repository is not attributable. The site runs GA4 via `@next/third-parties`, which reads `utm_*` query parameters on landing with no site change, so the whole task lives in this repository.

`README.md` links to the site on lines 11, 14, 53, 57, 61, 65, 93, 95 and 167 (badge, hero nav, four feature cards, docs trio, runner reference, footer) with bare URLs: `/`, `/docs`, `/docs/spec/spec`, `/docs/getting-started`, `/docs/concepts/{dor-gate,autonomous-orchestrator,cross-harness-review,operator-tui}`, `/docs/tutorials`, `/docs/api-reference`, `/docs/api-reference/runners`, `/pricing`.

The same README describes the framework as it was in mid-2026: the operator TUI (retired 2026-10-13, no further investment), `cli-orchestrator tick` behind `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` (retired for `cli-hierarchy`, RFC-0051, AISDLC-763), "a forthcoming Decision Catalog (RFC-0035, Draft)" (default ON), and "three reviewer subagents run in parallel on every change" (two-reviewer default since AISDLC-722). Attribution on links whose descriptions are wrong is half a fix, so the two go together.

Ordered after AISDLC-853, which also edits the README files (the site planner asked that the two not touch the same file in parallel).

**Five-step review (requirements first).** Requirement questioned: "add UTM parameters to the links". The requirement is attribution per placement; UTM is the mechanism GA4 already supports, so no site work, no redirect service, no shortener. Delete: the README paragraphs that describe retired surfaces (operator TUI card, orchestrator feature flag) and any link to a site path that no longer exists. Simplify: one taxonomy for the whole file, `utm_content` the only per-link variable. Accelerate: nothing, one file. Automate: a `node --test` check that every site URL in README.md carries the four parameters, so a later README edit cannot drop them (deterministic, no model call).

## Fix

1. Taxonomy, fixed for this file: `utm_source=github`, `utm_medium=readme`, `utm_campaign=ai-sdlc-repo`, `utm_content=<placement>`. Placements: `badge-docs`, `hero-website`, `hero-docs`, `hero-spec`, `hero-getting-started`, `feature-dor-gate`, `feature-hierarchy`, `feature-cross-harness-review`, `docs-getting-started`, `docs-tutorials`, `docs-api-reference`, `docs-runners`, `footer-website`, `footer-docs`, `footer-spec`, `footer-pricing`. Add or drop placements as the refresh adds or drops links; keep the prefix convention (`badge-`, `hero-`, `feature-`, `docs-`, `footer-`).
2. Rewrite every site href (host `ai-sdlc.io`) in README.md to `<path>?utm_source=github&utm_medium=readme&utm_campaign=ai-sdlc-repo&utm_content=<placement>`. The shields badge target (line 11) is included; the badge image URL is not a site link and stays.
3. Refresh the prose so each linked page is described as it is today: replace the operator-TUI card with the session hierarchy (`cli-hierarchy`, RFC-0051: planner, dispatch, executors) or drop the card if the site has no page for it; rewrite the orchestrator card around `cli-hierarchy up` with no experimental flag; state the Decision Catalog as shipped (RFC-0035, default ON, `cli-decisions`); state the reviewer set as configured (two by default, three available) with the attestation as the proof. Keep links only to paths that exist on ai-sdlc.io at PR time (HEAD request each one); where the site now serves pinned-source doc pages for a topic (AISDLC-853), point the docs links there.
4. Add `scripts/check-readme-utm.test.mjs` (`node --test`, wired into `pnpm test` the same way `scripts/check-claude-md-size.test.mjs` is): every site URL (host `ai-sdlc.io`) in README.md has all four `utm_*` parameters, `utm_content` values are unique within the file, no URL has two `?`.
5. Out of scope (follow-up if wanted): package READMEs on npm (`utm_medium=npm`), CONTRIBUTING.md, the plugin's SessionStart notices, docs pages that link back to the site. Same taxonomy, different `utm_medium`.

## Acceptance Criteria

- [ ] Every site link (host `ai-sdlc.io`) in README.md carries `utm_source=github`, `utm_medium=readme`, `utm_campaign=ai-sdlc-repo` and a `utm_content` placement unique within the file.
- [ ] README.md no longer describes the operator TUI, `cli-orchestrator tick`, the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flag, RFC-0035 as forthcoming, or three reviewers as the fixed set; the replacement text names `cli-hierarchy`, the shipped Decision Catalog and the configured reviewer set.
- [ ] Every linked site path returned 200 on ai-sdlc.io at PR time; the PR body lists the checked paths.
- [ ] `scripts/check-readme-utm.test.mjs` exists, runs under `pnpm test`, and fails when a site URL lacks a `utm_*` parameter or repeats a `utm_content` value.
- [ ] The PR body lists the placement taxonomy so the site side can add a GA4 dimension for `utm_content`.

**Velocity impact.** Neutral on agents; positive on product: the first attributable funnel from the repository, and a README that stops sending readers to retired features.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, docs only); operator-requested 2026-10-14 ("yes, file it now").
