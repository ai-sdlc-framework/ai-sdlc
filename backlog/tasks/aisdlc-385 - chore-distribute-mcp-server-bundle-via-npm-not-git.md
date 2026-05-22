---
id: AISDLC-385
title: 'chore: distribute mcp-server bundle via npm, not git'
status: To Do
labels:
  - architecture
  - plugin-distribution
  - tech-debt-removal
references:
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/mcp-server/package.json
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - scripts/check-mcp-bundle-sync.sh
  - scripts/verify-bundle.mjs
  - docs/operations/gate-friction-audit-2026.md
parentTaskId: AISDLC-384
---

## Description

Surfaced by the AISDLC-384 gate-friction audit (Gate 3 review).

The `ai-sdlc-plugin/mcp-server/dist/bin.js` bundle is currently committed to git at every commit because the Claude Code plugin marketplace clones the repo source without running `pnpm install`. Two gates exist solely to keep this checked-in artifact correct:

- `scripts/check-mcp-bundle-sync.sh` — pre-push hook (223 LOC) that auto-rebuilds the bundle whenever `pipeline-cli/src/**` changes (5 lifetime fires; 10-30s rebuild per fire)
- `scripts/verify-bundle.mjs` — CI gate that rejects PRs whose committed bundle is stale

Both exist to paper over a deeper architectural choice: committing a generated artifact to the source tree.

**The architecture is already 95% there**: the mcp-server is **already** a publishable npm package (`@ai-sdlc/plugin-mcp-server@0.9.2` with its own `publishConfig`, tracked by release-please at `release-please-config.json`). And the plugin **already** has a self-heal script (`scripts/install-runtime-deps.sh`) for the "marketplace doesn't npm install" gap on runtime dependencies. We just never wired the mcp-server through it.

## Acceptance criteria

- [ ] AC-1: `ai-sdlc-plugin/plugin.json` — `mcp-server` entry no longer references the in-tree `dist/bin.js`. Instead resolves the bin via the installed npm package `@ai-sdlc/plugin-mcp-server`.
- [ ] AC-2: `ai-sdlc-plugin/plugin.json` — `runtimeDependencies` includes `@ai-sdlc/plugin-mcp-server@<version>` pinned to the plugin's own version (or `*` if version-locked via package.json).
- [ ] AC-3: `scripts/install-runtime-deps.sh` — extended to install `@ai-sdlc/plugin-mcp-server` on first plugin invocation if not present.
- [ ] AC-4: `ai-sdlc-plugin/mcp-server/.gitignore` — adds `dist/` (and `dist/` removed from git history in the same PR via `git rm`).
- [ ] AC-5: `scripts/check-mcp-bundle-sync.sh` — DELETED (no longer needed).
- [ ] AC-6: `scripts/verify-bundle.mjs` + `Verify dist/bin.js` CI check — DELETED.
- [ ] AC-7: `.husky/pre-push` — `check-mcp-bundle-sync.sh` invocation removed; ordering doc updated.
- [ ] AC-8: Dogfood path validated — operator can still run the plugin from a local checkout by running `pnpm --filter @ai-sdlc/plugin-mcp-server build` once, with plugin self-heal preferring local `dist/` when present (topology 2 per `ai-sdlc-plugin/README.md`).
- [ ] AC-9: First-version chicken-and-egg handled — the PR that ships this MUST land alongside a release-please version bump that publishes `@ai-sdlc/plugin-mcp-server` to npm at the new version. Document the cutover in the PR body.
- [ ] AC-10: Adopter install path tested end-to-end — fresh `claude plugin install ai-sdlc` against a published version successfully loads the MCP server with no committed `dist/`.
- [ ] AC-11: CLAUDE.md "Hooks" section updated to remove the mcp-bundle-sync entry.
- [ ] AC-12: `docs/operations/gate-friction-audit-2026.md` Gate 3 verdict updated from "OPTIMIZE" to "DELETE (architectural — shipped via AISDLC-385)".

## Risks + mitigations

- **Dogfood disruption (operator-blocking)**: operator running plugin from main needs the local-build topology to work end-to-end. Mitigation: validate AC-8 with operator's dogfood loop before merging; provide a `pnpm bootstrap-plugin` convenience script if needed.
- **Version skew during PR review**: reviewer of a PR that changes mcp-server src can't easily test the plugin against that PR's bundle (npm doesn't have it yet). Mitigation: existing local-build path (topology 2) handles this; document the workflow explicitly.
- **First release after cutover**: needs careful staging — bundle must be on npm BEFORE the plugin.json change lands, or there's a window where adopters install a broken plugin. Mitigation: stage the npm publish first, then merge the plugin.json change in a follow-up.
- **release-please not configured to publish on every commit**: the mcp-server publishes only when release-please cuts a versioned release. Feature-branch adopters who pin to a non-released commit won't have a bundle. Mitigation: document that adopters MUST pin to a tagged release, not main HEAD.

## Estimated effort

1-2 days implementation + 1-2 day soak. Gate audit follow-up.

## Out of scope

- Refactoring other in-tree generated artifacts (`reference/src/core/generated-schemas.ts` — that's a different shape, separately tracked).
- Changing the plugin marketplace contract itself (Anthropic-owned).

## References

- [Gate friction audit (Gate 3)](docs/operations/gate-friction-audit-2026.md#gate-3)
- [Plugin install topology](ai-sdlc-plugin/README.md#installation-topologies) (section explains the existing self-heal pattern)
- AISDLC-357 origin task (the gate this PR deletes)
