---
id: AISDLC-600
title: >-
  Bump install-runtime-deps.sh pipeline-cli pin to the current runtime (off the caret-0.x trap) so execute's produce stamps independent
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - pipeline-cli
  - plugin
  - runtime-pin
  - adopter
  - consumer-produce
dependencies: []
references:
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - scripts/sync-plugin-runtime-deps.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Gap 3 of the consumer-produce triage (2026-09-07, local-trades).**

`ai-sdlc-plugin/scripts/install-runtime-deps.sh` pins `@ai-sdlc/pipeline-cli@^0.10.0`. The self-heal resolved the plugin `node_modules` to **0.21.0** while npm's latest is **0.23.0**. 0.21.0 has `cli-attestation` + the consumer verify fix (AISDLC-583) but NOT the RFC-0047 independence tier (0.23.0) — so a `/ai-sdlc execute` produce that uses `$PIPELINE_CLI_BIN` (the plugin runtime) stamps `verdictClass=self-authored` even when the marker is present, where 0.23.0 would stamp `independent`. (The triage was only able to get `independent` by producing with a *globally*-installed 0.23.0.)

The `^0.10.0` caret on a 0.x line is the AISDLC-574 caret-0.x trap: `^0.x` does NOT allow `0.(x+1)`, so the pin can never float past the minor it was written at without a manual bump.

## Scope
- Update `install-runtime-deps.sh`'s pin to track the current published runtime (`>=0.23` or an equivalent range that floats forward on 0.x minors — do NOT reintroduce a `^0.x` caret that traps at one minor, per AISDLC-574).
- Verify `scripts/sync-plugin-runtime-deps.mjs` (the AISDLC-574 pin-sync gate) keeps this pin coherent with the release-please version on future releases, so this doesn't silently drift again (recall `feedback_release_pr_needs_manual_pin_sync`).
- Re-check any other `^0.x` pipeline-cli pins in the plugin's install/runtime scripts for the same caret-0.x trap while here.

## Acceptance Criteria
- [ ] `install-runtime-deps.sh` self-heals the plugin `node_modules` to the current runtime (>=0.23.0), so `execute`'s produce path stamps `independent` (marker present) without the operator swapping in a global install.
- [ ] The pin range floats forward on future 0.x minor releases (not caret-trapped at one minor); AISDLC-574 pin-sync keeps it coherent with release-please.
- [ ] No remaining `^0.x` pipeline-cli caret pins in plugin install/runtime scripts.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Independent of AISDLC-598/599 (a pure pin bump) but they compose: 598 signs in-process, 599 supplies the leaves, and this ensures the runtime doing both is 0.23.0 so the result is `independent`, not `self-authored`. Gap 4 of the triage (monorepo-shaped Step 0/0.5 — `check-orchestrator-state.sh` hard-reset assumption, Pattern-C read-only contract, `sync-parent` aisdlc-N prefix) is lower severity and NOT filed here; capture separately if it becomes an adopter blocker.
