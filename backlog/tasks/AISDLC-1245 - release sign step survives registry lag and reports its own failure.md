---
id: AISDLC-1245
title: 'release.yml: the MCP tarball sign step polls the registry instead of sleeping 15s, and its exit guard actually runs under bash -e'
status: In Progress
assignee: []
created_date: '2026-11-08'
labels:
  - ci
  - release
  - supply-chain
dependencies: []
references:
  - .github/workflows/release.yml
  - scripts/sign-mcp-tarball.mjs
  - docs/operations/mcp-server-signing.md
priority: high
dispatchable: true
dispatchableReason: 'Filed by the planner after the v0.41.0 release of 2026-11-08 (run 42502073745). All seven npm packages published, then the DSSE sign step failed the whole job: the registry returned 404 for @ai-sdlc/plugin-mcp-server@0.41.0 fifteen seconds after publish (propagation lag), and the step''s exit-0 guard never ran because the step shell is bash -e and `node ...; SIGN_EXIT=$?` aborts on the node failure before the guard. No mcp-server envelope has ever been committed (git history has no .ai-sdlc/attestations/mcp-server-*.dsse.json), so every consumer''s SessionStart tarball verify soft-fails with a warning.'
---

## Description

**Gap.** `.github/workflows/release.yml`, step "Sign MCP server tarball DSSE attestation", runs after `pnpm -r publish`. It sleeps 15 seconds, then `scripts/sign-mcp-tarball.mjs` fetches the registry metadata for the just-published version. On 2026-11-08 (run 42502073745) the registry still returned 404 for `@ai-sdlc/plugin-mcp-server@0.41.0` at that moment (the version was visible from a laptop two minutes later), the script exited 1, and the job failed red although the publish itself had succeeded for all seven packages.

Two defects:
1. **Fixed sleep instead of a poll.** Registry propagation after publish is eventually consistent and routinely exceeds 15 seconds; the later "Rebuild plugin cache" step already retries for the same reason.
2. **Dead exit guard.** The step shell is `bash -e`. The sequence `node scripts/sign-mcp-tarball.mjs ...` then `SIGN_EXIT=$?` aborts the shell on the node failure, so the `if [ $SIGN_EXIT -ne 0 ]` branch (warning plus `exit 0`) never executes, and the "Commit signed MCP server tarball envelope" step is skipped. The documented soft-fail contract (docs/operations/mcp-server-signing.md) is therefore not what runs.

## Fix

**Five-step review.**
1. Question: should the sign step be soft-fail at all? Keep the documented contract (soft-fail with a loud warning, the tarball is already public), but make it true: a red job hides a successful publish and makes the operator think the release failed.
2. Delete: the fixed `sleep 15`.
3. Simplify: `if ! node scripts/sign-mcp-tarball.mjs ...; then warn; exit 0; fi` (or `set +e` around the call); poll `npm view @ai-sdlc/plugin-mcp-server@$MCP_VERSION dist.tarball` up to N times with a short backoff before signing, bounded (for example 10 attempts, 15 seconds apart).
4. Accelerate: none.
5. Automate: a shell-level test is not available for workflow steps; add a unit test to `scripts/sign-mcp-tarball.mjs` (or a small helper it imports) covering the retry-on-404 path, and a workflow-lint assertion (`scripts/check-*.test.mjs` style) that the step does not contain `; SIGN_EXIT=$?` under `bash -e`.

## Acceptance Criteria

- [ ] AC-1: the sign step waits for the published version to be visible on the registry with a bounded poll, not a fixed sleep; the bound and interval are named in the step.
- [ ] AC-2: a failing sign script produces the documented `::warning::` and `skipped=true` output and the job stays green; the "Commit signed MCP server tarball envelope" step still runs only when `skipped=false`.
- [ ] AC-3: a test covers the retry path of the sign script on a 404 that turns into a 200.
- [ ] AC-4: `docs/operations/mcp-server-signing.md` names the poll bound and states that the 0.41.0 envelope must be produced through the manual sign step (operator key).
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
