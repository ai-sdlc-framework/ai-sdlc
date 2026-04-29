# Changelog

All notable changes to the AI-SDLC Claude Code plugin (`ai-sdlc-plugin/`) are
documented in this file. The plugin version is tracked in `plugin.json`.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
with entries grouped under a release heading or `Unreleased` while in flight.

## Unreleased

### Added

- **CI-side attestor** (`scripts/ci-sign-attestation.mjs` +
  `.github/workflows/ai-sdlc-review.yml` Post Review Results step): when CI's
  three reviewer agents (testing/critic/security) all approve a PR AND the
  PR has no valid local attestation, CI signs a DSSE envelope with a
  `ci-attestor` key from GitHub Secrets and pushes it back to the PR branch
  with `[skip ci]`. The verifier (AISDLC-84/85) accepts CI-signed envelopes
  identically to maintainer-signed ones — same DSSE format, same predicate.
  Unblocks remote-agent `/ai-sdlc execute` runs (AISDLC-78/79/80/85 root
  cause was no signing key in the remote sandbox) and gives external
  contributors a zero-key path to a valid attestation. The CI signing step
  delegates the "should I sign?" decision to the existing verifier
  (`--skip-if-valid`), so it never redundantly signs over a valid local
  attestation but DOES sign additively alongside an invalid one (the
  multi-envelope scan picks the valid one). Step is gated to same-repo PRs
  via `head.repo.full_name == github.repository` — fork PRs cannot push to
  their head ref via GITHUB_TOKEN, so they get the existing friendly
  fallback comment instead. Bootstrap (one-time, maintainer-only) is
  documented in `CLAUDE.md` → "Bootstrap CI-side attestor": generate
  keypair, add private key as GH Secret `AI_SDLC_CI_ATTESTOR_PRIVATE_KEY`,
  uncomment + fill the placeholder in `.ai-sdlc/trusted-reviewers.yaml`,
  open onboarding PR. Until that PR merges, `verify-attestation.yml`
  rejects CI-signed envelopes with `signature did not match any trusted
  reviewer pubkey` — the SAFE default (CI signing is additive, never
  weakens the trust model). Regression coverage:
  `scripts/ci-sign-attestation.test.mjs` exercises the three core shapes
  (no-local-attestation → CI signs → verifier valid; valid-local → CI
  no-ops; invalid-local → CI signs additively → verifier picks valid one)
  end-to-end against the real verifier. (AISDLC-87)

### Documentation

- **Remote-agent usage policy** (`CLAUDE.md`): documented that Anthropic CCR
  remote agents (scheduled via the bundled `/schedule` skill,
  `Path: bundled:schedule`) are read-only by design. Empirical 4-for-4
  failure rate of `/ai-sdlc execute` over `/schedule` (AISDLC-78, -79, -80,
  -85) confirmed the structural blockers: no signing key in the remote
  sandbox, plugin not auto-installed, subagents not registered, no local
  worktree. The new `Remote agents (/schedule) — read-only by design`
  section in `CLAUDE.md` lists acceptable patterns (PR status surveys,
  backlog state reports, cron-triggered metric digests, Slack workflows,
  CI run surveys) and explicitly-prohibited patterns
  (`/ai-sdlc execute`, signing-key-dependent flows, plugin-subagent
  flows, worktree flows, cross-repo write flows). Notes AISDLC-87
  (CI-side attestor) as the planned fix that will eventually unblock
  remote-agent `/ai-sdlc execute`. Since the `/schedule` skill is
  system-bundled (not in this repo), the callout lives in `CLAUDE.md`
  per AISDLC-86 AC #4. (AISDLC-86)

### Changed

- **`/ai-sdlc execute`, `/ai-sdlc status`, `/ai-sdlc triage`**: rewired all
  call sites that previously used `mcp__backlog__task_edit` and
  `mcp__backlog__task_complete` to the plugin's drop-in replacements
  `mcp__ai-sdlc-plugin__task_edit` / `mcp__ai-sdlc-plugin__task_complete`
  (shipped in AISDLC-73). The new tools preserve unknown frontmatter keys
  verbatim — most importantly `permittedExternalPaths`, which the upstream
  tools silently strip on every status flip, breaking cross-repo writes for
  any task that needs them. `mcp__backlog__task_view` (read-only) continues
  to use upstream. (AISDLC-83)
- `ai-sdlc-plugin/commands/execute.md` `allowed-tools` frontmatter updated
  accordingly: removed upstream `mcp__backlog__task_edit` /
  `mcp__backlog__task_complete`, added the plugin equivalents.

### Notes

- No MCP server schema changes were required — the AISDLC-73 tool schemas
  (`status`, `acceptanceCriteriaCheck`, `finalSummary`, `updatedDate` for
  `task_edit`; `id`, `finalSummary`, `updatedDate` for `task_complete`)
  already cover every field `/ai-sdlc execute` needs. No bundle rebuild
  was needed for AISDLC-83.
- AC #4 of AISDLC-83 (end-to-end dogfood verification with a task carrying
  `permittedExternalPaths`) is intentionally deferred to a manual run by
  the human operator after this PR merges.
