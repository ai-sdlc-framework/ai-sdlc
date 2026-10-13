---
id: AISDLC-846
title: >-
  wire pnpm lint:publishable into pnpm test
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - release
dependencies: []
references:
  - package.json
  - scripts/check-publishable-package-configs.mjs
  - docs/operations/release-and-plugin-reference.md
  - CLAUDE.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`pnpm lint:publishable` (`node scripts/check-publishable-package-configs.mjs`) is documented as wired into `pnpm test` (`docs/operations/release-and-plugin-reference.md`) and CLAUDE.md tells contributors to run it, but no workflow and no `test` chain entry calls it; `grep` finds only the `package.json` definition and its unit test (`docs/audits/2026-10-13-cicd-five-step-audit.md`, finding F9). A new publishable package without `publishConfig` is rejected by npm with E402 silently per package while the release job looks green.

**Five-step review (requirements first).** Requirement questioned: "the publishConfig lint is optional" versus the documented claim that it gates `pnpm test`. The claim is the stated requirement (release-flow docs), so the stated property is made true instead of deleting the sentence. Delete: the false documentation claim, by making it accurate. Simplify: one entry appended to the existing `test` chain, no new workflow step. Accelerate: the script is a static scan of package manifests, instant. Automate: this is the automation. Not a weakening.

## Fix

1. `package.json`: append `&& pnpm lint:publishable` to the `test` script (after `pnpm sync:plugin-runtime-deps:check`).
2. Run it once; if it reports a package without `publishConfig`, add the `publishConfig` block (the `access: public` block with the npm registry URL) or mark the package `"private": true`, per the CLAUDE.md release rules.
3. `docs/operations/release-and-plugin-reference.md`: remove the sentence asking the operator to wire an extra CI step in `ci.yml` (it runs inside `pnpm test` in the gate).
4. Keep the CLAUDE.md pointer; it is now true.

**Velocity impact.** Neutral: an instant static scan inside an existing test run; closes a documented-but-unwired guard.

Authority: class (a) decision under `docs/operations/decision-authority.md` (reversible, non-weakening, derived from the 2026-10-13 audit; no decision record required).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `pnpm test` runs `pnpm lint:publishable` and passes on main
- [ ] #2 `docs/operations/release-and-plugin-reference.md` no longer asks for a separate CI step
- [ ] #3 A package manifest without `publishConfig` (and not private) makes `pnpm test` fail (covered by the existing unit test of the script)
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
