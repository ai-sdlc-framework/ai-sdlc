---
id: AISDLC-537
title: >-
  chore(deps): bump Next.js in dashboard to resolve high-severity advisories
  (SSRF, DoS, middleware/proxy bypass)
status: To Do
assignee: []
labels:
  - security
  - dependencies
  - dashboard
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - dashboard/package.json
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dependabot reports **8 open HIGH advisories against `next`** (runtime, dashboard), including:
server-side request forgery in `app`, multiple Denial-of-Service vectors (Server Components,
connection handling), and Middleware/Proxy bypass in both the App Router and Pages Router.
The dashboard is the operator/marketing surface (not a public-internet prod server), so the
practical blast radius is lower than for an exposed app — but these are real and the fix is a
straightforward version bump.

**Fix:** bump `next` in `dashboard/package.json` to the latest patched release that clears all
the flagged advisories (check the GitHub advisory "patched versions" for each, take the max),
regenerate the lockfile, and verify the dashboard builds + its tests/lint pass. Next majors can
carry breaking changes — if the patched version crosses a major, validate the build carefully
(App Router config, middleware API) and note any required code changes in the PR. If react/
react-dom need a coordinated bump alongside next, do it in the same PR (note: AISDLC-534-era
dependabot config now ignores react PATCH bumps, so a deliberate minor/major react bump here is
the intended path).

Verify against the live dependabot alert list (`gh api repos/<org>/<repo>/dependabot/alerts?
state=open`) for the exact advisories + patched versions at implementation time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `next` in dashboard/package.json bumped to a release that clears all 8 flagged HIGH advisories (SSRF, DoS x3, middleware/proxy bypass x3); lockfile regenerated
- [ ] #2 `pnpm --filter <dashboard> build` succeeds; any breaking-change adaptations documented in the PR body
- [ ] #3 Dashboard tests + lint pass; if react/react-dom were co-bumped, the EXACT-version match is preserved (the original react-mismatch build failure does not recur)
- [ ] #4 Post-merge dependabot re-scan shows the `next` HIGH advisories resolved
<!-- AC:END -->
