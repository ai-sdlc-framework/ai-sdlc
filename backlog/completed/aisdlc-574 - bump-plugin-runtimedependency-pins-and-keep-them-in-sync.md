---
id: aisdlc-574
title: Plugin runtimeDependencies pinned at ^0.14.0 freeze the attestation runtime — bump + keep in sync
status: Done
priority: high
labels:
  - bug
  - plugin
  - attestation
  - adoption
---

## Description

The plugin's `runtimeDependencies` in BOTH `ai-sdlc-plugin/.claude-plugin/plugin.json`
and `ai-sdlc-plugin/plugin.json` pin `@ai-sdlc/orchestrator` and `@ai-sdlc/pipeline-cli`
at **`^0.14.0`**. On a 0.x version npm's caret means `>=0.14.0 <0.15.0`, so it resolves
to **0.14.0** — the only 0.14.x published. Meanwhile the workspace packages are at
**0.19.0**.

**Impact (verified):** `@ai-sdlc/pipeline-cli@0.14.0` contains NO `verdict-class` or
`harness-transcript` modules (both first shipped in 0.17.0 / 0.19.0). So the plugin
(0.16.0) ships the verdictClass **producers** — the SubagentStart marker hook
(AISDLC-572) and the nonce injection (AISDLC-573) — but pins a runtime **consumer**
(0.14.0) with no `determineVerdictClass` and no `harnessTranscriptHash`. An adopter on
v6 gets signed leaves with NO verdictClass → the verifier reads every leaf
`self-authored`. More broadly, the `^0.14.0` pin freezes the ENTIRE
pipeline-cli/orchestrator runtime at 0.14.0, so the runtime-side of AISDLC-566/568/570/
572/573 is unreachable by adopters.

**Root cause:** release-please bumps the workspace package versions AND the plugin's
own version (via `ai-sdlc-plugin` extra-files: plugin.json/marketplace.json/mcp-server
`$.version`), but it never touches the `runtimeDependencies` PINS. They've been frozen
at `^0.14.0` since AISDLC-554 added them. Same manifest-drift class as AISDLC-558/571.

Also: `MIN_RUNTIME_VERSIONS` in `ai-sdlc-plugin/scripts/sign-attestation.mjs` is
`[0,14,0]` for both packages, so the min-version guard doesn't enforce the
verdictClass/harnessTranscript floor either.

## Scope

1. **Immediate bump:** update `runtimeDependencies` for `@ai-sdlc/orchestrator` and
   `@ai-sdlc/pipeline-cli` in BOTH manifests from `^0.14.0` to a range that includes
   0.19.0 (the verdictClass + harnessTranscript-bearing runtime). Given caret-on-0.x
   caps at the minor, decide the pin form (e.g. `^0.19.0` for now, or a
   `>=0.19.0 <1` style if the team accepts 0.x-minor forward-compat) and document the
   choice. Keep both manifests identical (per AISDLC-571 conformance).
2. **Min-version guard:** bump `MIN_RUNTIME_VERSIONS` in `sign-attestation.mjs` to the
   floor that actually has the features the plugin's producers depend on
   (harnessTranscript is 0.19.0; verdictClass 0.17.0 — use `[0,19,0]` so the guard
   enforces the current runtime). Confirm `install-runtime-deps.sh` installs the bumped
   pins (it reads them from the manifest).
3. **Durable sync (the structural fix — prevents recurrence):** make release-please
   keep the `runtimeDependencies` pins in step with the released runtime versions on
   every release (e.g. add `runtimeDependencies` jsonpath entries to the plugin's
   release-please `extra-files`, or a linked-versions config, or — if release-please
   can't source a sibling component's version — a release/CI step or hook that rewrites
   the pins to the just-released orchestrator/pipeline-cli versions). Pick the
   mechanism that release-please actually supports and wire it.
4. **Drift-guard test (the AISDLC-571 pattern):** a conformance test that FAILS when
   the plugin's `runtimeDependencies` pin for orchestrator/pipeline-cli does not
   include the current workspace package version (i.e. would catch the pin lagging the
   release). Must fail on the pre-fix `^0.14.0` state, pass after.

## Acceptance Criteria

- [x] Both manifests pin orchestrator + pipeline-cli at a range that resolves to
      >= 0.19.0; the two manifests are identical.
- [x] `MIN_RUNTIME_VERSIONS` bumped so the guard enforces the verdictClass/
      harnessTranscript-bearing floor; `install-runtime-deps.sh` installs the bumped pins.
- [x] A durable mechanism keeps the pins in sync with the released runtime on future
      releases (documented + wired).
- [x] A conformance/drift test fails on the pre-fix `^0.14.0` state and passes after,
      guarding against the pin lagging the workspace version again.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Resolution (AISDLC-574 implementation)

1. **Pins bumped** to `^0.19.0` for `@ai-sdlc/orchestrator` and
   `@ai-sdlc/pipeline-cli` in both `ai-sdlc-plugin/plugin.json` and
   `ai-sdlc-plugin/.claude-plugin/plugin.json`. Verified with `npx semver -r
   '^0.19.0' 0.19.0 0.14.0 0.20.0` → resolves to `0.19.0` only. Caps at
   `<0.20.0`; kept current going forward by the sync mechanism (item 3).
2. `MIN_RUNTIME_VERSIONS` in `ai-sdlc-plugin/scripts/sign-attestation.mjs`
   bumped to `[0,19,0]` for both packages. `install-runtime-deps.sh` already
   reads pins from `plugin.json` at runtime (verified — no hardcoded
   version), so it picks up the bump automatically.
3. **Durable sync (Option C chosen):** `.github/workflows/release.yml`
   `extra-files` writes each component's OWN `$.version` — confirmed this
   does NOT solve cross-component pins, since the plugin's own version
   (0.16.x) differs from the runtime line (0.19.x). Instead, added
   `scripts/sync-plugin-runtime-deps.mjs`, a script that reads the
   *workspace* orchestrator/pipeline-cli `package.json` versions (source of
   truth, the same files release-please bumps) and rewrites the
   `runtimeDependencies` pin in both plugin manifests to `^<version>` when
   drifted. Wired as a new `sync-plugin-runtime-deps` job in
   `.github/workflows/release.yml`, gated on
   `orchestrator--release_created` / `pipeline-cli--release_created`,
   committing directly to `main` (same pattern as the existing MCP-tarball
   sign step). `pnpm sync:plugin-runtime-deps:check` runs the script in
   `--check` mode (no writes) as part of `pnpm test`.
4. **Drift-guard test** added to
   `ai-sdlc-plugin/scripts/install-runtime-deps.test.mjs` (new describe
   block `AISDLC-574`), asserting each manifest's pin resolves to >= the
   current workspace package version. Verified it FAILS on the pre-fix
   `^0.14.0` state (stashed the bump, ran the suite: 2 failures) and PASSES
   after restoring the fix (24/24 pass).

## Note

This unblocks the ENTIRE upstream verdictClass/harnessTranscript adoption path
(AISDLC-568/570/572/573) for consumers, not just verdictClass. Composes with the
manifest-single-source structural work in [[aisdlc-558]].
