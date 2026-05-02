---
id: AISDLC-97
title: Investigate why publishConfig was lost from mcp-server/package.json on main
status: Done
assignee: []
created_date: '2026-04-30 21:38'
updated_date: '2026-05-01 00:43'
labels:
  - bug
  - ci
  - release-please
  - publish
  - operational-friction
dependencies:
  - AISDLC-96
references:
  - ai-sdlc-plugin/mcp-server/package.json
  - release-please-config.json
  - .release-please-manifest.json
  - backlog/completed/aisdlc-75 - Fix-ai-sdlc-plugin-distribution-mcp-server-ships-without-dist-node_modules-breaks-all-governance-hooks-on-cached-install.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Trigger:** PR #100 (release-please v0.8.1 release) failed `pnpm -r publish` with `E402 Payment Required` for `@ai-sdlc/plugin-mcp-server`. Root cause: `publishConfig.access: public` was missing from `ai-sdlc-plugin/mcp-server/package.json` on `main`.

**Surprising part:** PR #54 (the v0.8.0 release) explicitly added the publishConfig block to fix the same E402 error. v0.8.0 published successfully. But somehow the publishConfig was missing from main when v0.8.1 went to publish.

Sibling packages (`orchestrator`, `mcp-advisor`, `sdk-typescript`) all retained their publishConfig blocks correctly. Only `mcp-server` lost it.

## Possible root causes

1. **release-please regenerated package.json** — when release-please cut v0.8.1, it might have used a cached/template version of package.json that didn't include the publishConfig (which was a manual addition not in any release-please config).
2. **Squash-merge stripped the fix from PR #54's history** — if PR #54 was squash-merged, only the squash commit's diff lands on main. If the publishConfig was added in a separate commit on the PR branch and the squash didn't include it, it'd be lost.
3. **Force-push to PR #54 reverted the fix** — if a subsequent force-push to PR #54's branch overwrote the publishConfig commit, the merged state would not include it.
4. **release-please rebased its own branch** — release-please can rewrite history of its own branch on subsequent runs. If the v0.8.0 publish happened from a branch state with publishConfig, but then release-please rebased the branch (resetting to base + bot commits only), the manual fix would be erased.

## Investigation steps

1. Check the merge commit for PR #54 (look at what files changed on main as a result of the merge). Did publishConfig land on main, or was it only on the PR branch?
2. Check git log of `ai-sdlc-plugin/mcp-server/package.json` on main between the v0.8.0 release commit and now — did publishConfig appear and then disappear in some commit?
3. Check release-please-config.json — does it have any package-template behavior for mcp-server that would reset its content?
4. Compare the v0.7.1 → v0.8.0 release commit (3f6969c) to the v0.8.0 → v0.8.1 release commit (3453ab2). What did each change?
5. If release-please IS the cause, document a long-term fix: either configure release-please to preserve publishConfig OR add a release-please post-process step (companion to AISDLC-96's prettier post-process) that re-adds publishConfig if missing.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Identify the actual root cause from steps 1-4 above (commit-by-commit forensic)
2. Document findings in this task's `notes` field
3. If release-please is at fault: implement either (a) release-please-config update to preserve the field, or (b) post-process step (composable with AISDLC-96)
4. If squash/force-push is at fault: document the mitigation (branch protection rule that prevents force-push? CODEOWNERS for package.json files?)
5. Add a CI lint check that asserts every publishable package's `package.json` has `publishConfig.access: public` AND the canonical registry URL — catches the next regression at PR-CI time, not at publish-fail time
6. All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## Composition with AISDLC-96

Both tasks address release-please workflow gaps:
- **AISDLC-96** — prettier post-process (release-please doesn't run prettier)
- **AISDLC-97** — publishConfig persistence (release-please may strip non-version fields)

If both turn out to need the same fix mechanism (a release-please post-process workflow), bundle them — implement once, cover both.

## References

- PR #54 (v0.8.0 release) — first added publishConfig to fix E402
- PR #100 (v0.8.1 release) — exposed that publishConfig was missing from main
- Workaround applied: chore commit on PR #100's release-please branch directly re-added publishConfig (commit `f5b7afd`)
- AISDLC-96 — sibling task (release-please prettier post-process)
- `ai-sdlc-plugin/mcp-server/package.json` — the affected file
- `release-please-config.json` — release-please config to investigate
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Forensic investigation: identify the actual root cause of why publishConfig was lost from `ai-sdlc-plugin/mcp-server/package.json` on main between PR #54 (v0.8.0) and PR #100 (v0.8.1). Document findings in task notes.
- [x] #2 If release-please is at fault: implement either release-please-config update to preserve `publishConfig` OR a post-process step (composable with AISDLC-96)
- [ ] #3 If squash-merge or force-push is at fault: document mitigation (branch protection rule, CODEOWNERS for package.json, etc.)
- [x] #4 Add CI lint check: every publishable package's package.json MUST have `publishConfig.access: public` AND the canonical npm registry URL. Catches the next regression at PR-CI time, not at publish-fail time.
- [x] #5 Document findings + mitigation in CLAUDE.md `Releases` section so future operators know to spot-check publishConfig before merging release-please PRs
- [x] #6 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Forensic investigation revealed the publishConfig was NEVER on main before our PR #103 workaround (`1c8b584`). v0.8.0's npm publish ALSO failed (E402); npm only has v0.8.1. Original session memory was wrong — there was no fix to lose. Shipped a CI lint script that asserts every publishable workspace package has `publishConfig.access: public` AND the canonical npm registry URL — catches the next regression at PR-CI time, not at publish-fail time.

## Changes

- `scripts/check-publishable-package-configs.mjs` — NEW lint script
- `scripts/check-publishable-package-configs.test.mjs` — NEW 20 tests
- `package.json` — adds `pnpm lint:publishable` + folds into `pnpm test:publishable`
- `CLAUDE.md` — new "Releases / Publishable package configs (AISDLC-97)" section

## AC status

- ✓ AC #1, #2, #4, #5, #6 — fully met
- ✗ AC #3 (release-please post-process) — INTENTIONALLY skipped: forensic finding ruled out release-please as the cause. release-please's `extra-files` entry only touches `$.version`, doesn't regenerate the file or strip publishConfig. Documented in CLAUDE.md "Why release-please can't fix this for us"

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- `pnpm lint:publishable` — 8/8 publishable packages pass
- `node --test scripts/check-publishable-package-configs.test.mjs` — 20/20 pass
- 3 parallel reviews APPROVED (0 critical, 0 major, 3 minor, 2 suggestions); ⚠ INDEPENDENCE NOT ENFORCED

## Operator follow-up

Wire `pnpm lint:publishable` as an explicit step in `.github/workflows/ci.yml` (workflow file blocked from developer subagent):
```yaml
- name: Lint publishable package configs
  run: pnpm lint:publishable
```
The script also runs as part of `pnpm test:publishable` which is folded into `pnpm test`, so CI catches it via the existing test step. The standalone `pnpm lint:publishable` gives a clearer single-line CI check name.

## Reversal of AISDLC-96 composition note

The original task description suggested AISDLC-96's prettier post-process workflow could ALSO re-apply publishConfig. Forensic finding REVERSES this: the field isn't stripped by release-please — it just was never added in the first place. The lint check shipped here is the right defense; AISDLC-96 stays scoped to prettier formatting only.
<!-- SECTION:FINAL_SUMMARY:END -->
