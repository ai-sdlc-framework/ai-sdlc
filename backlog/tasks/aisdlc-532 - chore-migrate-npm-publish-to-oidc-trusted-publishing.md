---
id: AISDLC-532
title: >-
  chore(release): migrate npm publishing from long-lived NPM_TOKEN to OIDC
  trusted publishing
status: To Do
assignee: []
labels:
  - chore
  - security
  - release
  - ci:no-issue-required
priority: medium
dependencies: []
dispatchable: false
dispatchableReason: >-
  Operator-coordinated: the npmjs.com per-package trusted-publisher config is operator-only
  and is a HARD precondition for the workflow change (removing the token before npmjs trusts
  the workflow breaks the next release). Also a pnpm 9->10 MAJOR upgrade that needs careful
  verification. Operator sequences; the pnpm+workflow edit may be dispatched as a sub-step
  only AFTER the npmjs config is in place.
references:
  - .github/workflows/release.yml
  - package.json
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the long-lived `NPM_TOKEN` GitHub Actions secret (consumed at `release.yml` `pnpm -r publish` via `NODE_AUTH_TOKEN`) with **npm OIDC trusted publishing**, so npm publishes use a short-lived credential minted from the workflow's OIDC identity — no rotatable secret. PyPI in this same workflow already uses OIDC trusted publishing (`pypa/gh-action-pypi-publish`, `id-token: write`), so the pattern is proven here; npm just needs per-package config + a tooling-version bump.

**Blocker (verified 2026-06-10):** the repo is on `pnpm@9.15.4`, which does NOT support OIDC trusted publishing. Support landed in **pnpm 10.x** (OIDC exchange in `pnpm publish`; needs npm CLI >= 11.5.1 underneath). Two approaches:

- **Approach A (recommended):** bump `packageManager` to an OIDC-capable `pnpm@10.x` (confirm the exact minimum in pnpm's release notes), keep `pnpm -r publish`, drop the token env. Risk: pnpm 9->10 is a MAJOR — verify the whole monorepo installs/builds/tests + the lockfile is regenerated cleanly on pnpm 10 in a dedicated PR (do NOT bundle unrelated changes).
- **Approach B:** replace `pnpm -r publish` with a per-package `npm publish` loop (npm >= 11.5.1). Avoids the pnpm major but you hand-manage workspace `workspace:*` resolution + the publish loop.

**npmjs.com config (operator-only, HARD PRECONDITION — must be done before removing the token):** for EACH published package, add a GitHub Actions trusted publisher (org `ai-sdlc-framework`, repo `ai-sdlc`, workflow `release.yml`). npm trusted publishing is PER-PACKAGE (no scope-level yet). The 5 published packages:
- `@ai-sdlc/orchestrator`
- `@ai-sdlc/reference`
- `@ai-sdlc/pipeline-cli`
- `@ai-sdlc/mcp-advisor`
- `@ai-sdlc/plugin-mcp-server`
All are already published, so they are eligible for trusted-publisher config.

**release.yml changes:** `permissions: id-token: write` is ALREADY present (used for provenance today). Remove `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from the publish step; `--provenance` becomes automatic under trusted publishing (drop the flag); keep the npm `registry-url` setup-node config.

**Rollout sequencing (avoid a broken release):**
1. Operator configures trusted publishers on npmjs for all 5 packages.
2. Bump pnpm to OIDC-capable 10.x (Approach A) in a dedicated PR; verify install/build/test + lockfile regen green.
3. Edit release.yml to drop `NODE_AUTH_TOKEN` (rely on OIDC).
4. Validate the next release actually publishes via OIDC (watch the `publish-npm` job).
5. Operator DELETES the `NPM_TOKEN` secret once trusted publishing is confirmed working.

**Follow-on note:** any NEW publishable package added later must get its own trusted-publisher config before its first CI publish.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 (operator) A GitHub Actions trusted publisher is configured on npmjs.com for all 5 published packages (orchestrator, reference, pipeline-cli, mcp-advisor, plugin-mcp-server): org ai-sdlc-framework, repo ai-sdlc, workflow release.yml
- [ ] #2 Tooling supports OIDC publishing: either packageManager bumped to an OIDC-capable pnpm 10.x with the monorepo installing/building/testing green + lockfile regenerated (Approach A), OR the publish step switched to npm publish (npm >= 11.5.1) per package (Approach B)
- [ ] #3 release.yml publish step no longer references NODE_AUTH_TOKEN / NPM_TOKEN; id-token: write retained; registry-url retained; --provenance dropped (automatic under trusted publishing)
- [ ] #4 A release run publishes all packages successfully via OIDC trusted publishing (verified on the publish-npm job — no E401/E403; provenance attestations still produced)
- [ ] #5 (operator) The NPM_TOKEN GitHub Actions secret is DELETED after trusted publishing is confirmed working
- [ ] #6 docs/operations/release-flow.md updated to document trusted publishing + the per-package trusted-publisher requirement for any new package
<!-- AC:END -->
