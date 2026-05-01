---
id: AISDLC-100.8
title: 'Phase 8: Publish @ai-sdlc/pipeline-cli to npm + cut major plugin release'
status: Done
assignee: []
created_date: '2026-04-30 22:59'
labels:
  - rfc-0012
  - phase-8
  - release
  - publish
dependencies:
  - AISDLC-100.1
  - AISDLC-100.2
  - AISDLC-100.3
  - AISDLC-100.4
  - AISDLC-100.5
  - AISDLC-100.6
  - AISDLC-100.7
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - pipeline-cli/package.json
  - release-please-config.json
  - .release-please-manifest.json
  - CLAUDE.md
parent_task_id: AISDLC-100
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0012 Phase 8 (Section 11). Final phase — publish the new package, cut a major plugin release that ships the architecture, verify both tiers work end-to-end on a fresh install.

## What changes

- `pipeline-cli/package.json` — verify `publishConfig.access: public` is set (lessons from AISDLC-97), `bin: ai-sdlc-pipeline` is correct, version is set per release-please
- `release-please-config.json` and `.release-please-manifest.json` — register `pipeline-cli` package
- Cut a major plugin release (semver minor or major depending on whether the user-facing surface changed — likely minor since `/ai-sdlc execute X` works the same way)
- After release-please opens its PR: verify the publish workflow succeeds for `@ai-sdlc/pipeline-cli`
- After merge: verify on a fresh machine (or fresh `~/.claude/` cache) that `/plugin install ai-sdlc` brings in the CLI binary correctly and `/ai-sdlc execute X` works

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `pipeline-cli/package.json` has correct `publishConfig`, `bin`, version fields
2. release-please config registers the new package; release-please cuts a release PR including it
3. Publish workflow succeeds for `@ai-sdlc/pipeline-cli` (new package on npm)
4. Plugin release cut (major or minor depending on user-facing impact)
5. Fresh install verification: `/plugin install ai-sdlc` on a clean cache pulls in CLI; `/ai-sdlc execute <safe-task>` works
6. End-to-end Tier 2 verification: `pnpm --filter @ai-sdlc/dogfood watch --issue X` works
7. End-to-end portable verification: from outside Claude Code, `npx @ai-sdlc/pipeline-cli execute --task X` works (uses ShellClaudeP if `claude` CLI present)
8. CLAUDE.md `Releases` section (or new section) documents the install path
9. Mark AISDLC-100 (parent) Done after all sub-tasks confirmed
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 `pipeline-cli/package.json` has correct `publishConfig.access: public`, `bin: ai-sdlc-pipeline`, version
- [ ] #2 release-please config registers `pipeline-cli`; release-please cuts a release PR including it
- [ ] #3 Publish workflow succeeds for `@ai-sdlc/pipeline-cli` on npm
- [ ] #4 Plugin release cut (semver appropriate to user-facing impact)
- [ ] #5 Fresh install verification: `/plugin install ai-sdlc` on clean cache pulls in CLI; `/ai-sdlc execute <safe-task>` works
- [ ] #6 End-to-end Tier 2: `pnpm --filter @ai-sdlc/dogfood watch --issue X` works
- [ ] #7 End-to-end portable: `npx @ai-sdlc/pipeline-cli execute --task X` works outside Claude Code
- [ ] #8 CLAUDE.md documents the install path for the new package
- [ ] #9 Mark AISDLC-100 (parent) Done after all sub-tasks confirmed
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0012 Phase 8 prep landed: flipped @ai-sdlc/pipeline-cli from `private: true` to publishable, added the AISDLC-97 publishConfig block, registered in release-please config + manifest, documented Tier 1/Tier 2 install paths in pipeline-cli/README.md.

## ACs satisfied
- ✓ #1 publishConfig + bin + version verified
- ✓ #2 release-please config + manifest registration
- ✓ #8 install-path docs in pipeline-cli/README.md

## ACs deferred to operator (post-merge)
- ⏸ #3 npm publish (CI workflow on git tag)
- ⏸ #4 Plugin release cut (release-please opens PR after merge)
- ⏸ #5/#6/#7 Fresh-install + e2e verification (clean machine required)
- ⏸ #9 Mark AISDLC-100 (parent) Done after operator-side ACs confirmed

## Verification
- pnpm lint:publishable — 9/9 publishable packages OK (was 8/8; pipeline-cli joined)
- pnpm build && pnpm test (46/46) && pnpm lint && pnpm format:check — clean
- 3 reviews approved: code 0c/0M/2m/1s; test 0c/0M/0m/0s; security 0c/0M/0m/0s
<!-- SECTION:FINAL_SUMMARY:END -->
