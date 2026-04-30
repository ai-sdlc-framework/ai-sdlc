# Changelog

## [0.8.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.8.0...ai-sdlc-plugin-v0.8.1) (2026-04-30)


### Bug Fixes

* address reviewer feedback for orchestrator fix (AISDLC-90) ([529d22c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/529d22c5e4162d1a95b8e1af9d2c1ee975aa0667))
* execute-orchestrator tool declarations (AISDLC-90) ([c27f769](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c27f7690cdf3c9511859b08c19e81a215df5155b))

## [0.8.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.7.1...ai-sdlc-plugin-v0.8.0) (2026-04-29)


### Features

* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* **ci:** ci-side attestor signs attestations after reviewer approval (AISDLC-87) ([bcc811d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcc811d10981e01275066ec235f5ff146b1b8927))
* execute-orchestrator subagent for first-class parallel runs (AISDLC-82) ([e48a7cd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e48a7cd9ca33905a891377fa48931b7003ba3c46))
* harden plugin hooks for coverage, turbo, and .env ([a688dc5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a688dc55c268244a37b066f577022d8159a0eb71))
* **orchestrator:** /ai-sdlc execute slash command for backlog tasks ([f0ddaa1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f0ddaa1794034b7519b52040e2ff3ad86c927930))
* **orchestrator:** cryptographic review attestations for skip-duplicate-CI (AISDLC-74) ([a120071](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a120071720d91545c51b6c91b05a3ffb223d2cf5))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** subagentStart governance + write/edit blocked-path enforcement ([7fbe49b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7fbe49b09f86fe1397fbf3a3c59c65700c9052f3))
* rewrite fix-pr skill to chain cli-fix-ci + cli-fix-review ([e03241c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e03241c4863de661cf23cc0af4f08fe443867db7))
* rewrite review skill to invoke cli-review ([71a6cf0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/71a6cf00a0d12a920e63baf197e1044dcb87a550))
* rewrite triage skill to use RFC-0008 admission composite ([28d26a8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/28d26a899160b85a3ec6d294c58d85e27e7a5f21))
* triage skill renders provenance + quality flags ([324de6b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/324de6b496a22c608099148c75b9a777b389276e))


### Bug Fixes

* bundle ai-sdlc-plugin mcp-server + commit dist/bin.js (AISDLC-75) ([2251558](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2251558c555edb2d1bf66671bdc683bd6f01cfad))
* coverage hook skips gracefully when @vitest/coverage-v8 not installed ([ee5f86f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ee5f86fa4c4f5d915332a664dbfbcb233caf7c03))
* coverage hook uses test:coverage script instead of passing --coverage flag ([4c35ebd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c35ebdb32806292d862d392c225d0f0da9fb2ed))
* **orchestrator:** active-task sentinel file (env vars don't propagate mid-session) ([1fafb58](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1fafb58d1a3900c7d3cb6ecb3b9464f631bb16b5))
* **orchestrator:** preserve unknown frontmatter fields in backlog task editor (AISDLC-73) ([6744997](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6744997a8f56c2651c88d279333c765749bc7c8d))
* **orchestrator:** schema-validate attestation predicate + sanitize GITHUB_OUTPUT (AISDLC-74) ([09ccaf3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09ccaf3c66709ae93af06a59d3cfbe617a7281e4))
* per-worktree active-task sentinel for parallel /ai-sdlc execute (AISDLC-81) ([8c6bb4f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8c6bb4f86515a2353d2a7c52e3e60315190f26fb))
* plugin install fixes, quality gate false positives, gitignore deduplication ([cf84f09](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf84f09cf93aabd8e22acc5e0262a4ed22d4e4e0))

## Changelog

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
