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

- **Pipeline step functions exposed as MCP tools** (`ai-sdlc-plugin/mcp-server/src/tools/pipeline-tools.ts`)
  — RFC-0012 Phase 3. Each Step 0-13 function from `@ai-sdlc/pipeline-cli`
  (AISDLC-100.1) is now wrapped as an MCP tool named
  `pipeline_step_<N>_<name>` (`pipeline_step_0_sweep`,
  `pipeline_step_1_validate`, …, `pipeline_step_13_cleanup`) so the
  `/ai-sdlc execute` slash command body can invoke each phase via
  `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_step_<N>_<name>` instead of
  shelling out to the `ai-sdlc-pipeline` CLI binary inline. Each tool's
  input schema mirrors the corresponding `Options` interface; each tool's
  output is the structured `Result` type JSON-serialised inside an MCP
  `text` content item. Step 9 (the iteration loop — the only step that
  needs an LLM dispatch boundary) lazily resolves the production
  `defaultSpawner()` from `@ai-sdlc/pipeline-cli/runtime` (AISDLC-100.2 —
  `ShellClaudePSpawner` if `claude` is on PATH, `ClaudeCodeSDKSpawner` if
  `ANTHROPIC_API_KEY` is set, throws otherwise per RFC-0012 §8.3). Tests
  inject `stepRunners` + `spawnerFactory` via `PipelineToolDeps` so they
  don't shell out to claude or hit the Anthropic API. The existing 7
  governance tools (`task_edit`, `task_complete`,
  `get_governance_context`, `get_review_policy`,
  `list_detected_patterns`, `check_pr_status`, `check_issue`) continue to
  register unchanged — total registered tool count is now 21. Test
  coverage: 25 new vitest cases in `pipeline-tools.test.ts` covering
  registration shape (14 tools, naming, descriptions, schemas), per-step
  successful invocation with mocked step + spawner, schema validation
  rejection on missing/malformed inputs, and error propagation through
  `isError` text results. New `@ai-sdlc/pipeline-cli` workspace
  dependency added to `ai-sdlc-plugin/mcp-server/package.json`. Bundle
  size grew from ~600KB to 791KB to inline the pipeline-cli step
  functions (the marketplace clone of the plugin still works without
  `pnpm install` — esbuild rolls every runtime dep into `dist/bin.js`,
  the AISDLC-75 contract). (AISDLC-100.3)

- **rebase-resolver subagent + `/ai-sdlc rebase` slash command** (AISDLC-105) —
  new `agents/rebase-resolver.md` plugin subagent + `commands/rebase.md` slash
  command body that automate the mechanical 80% of PR rebase + conflict
  resolution and escalate the architectural 20%. Surfaced 2026-05-01 after the
  orchestrator did 6+ manual rebase rounds across PRs #113, #114, #115 in one
  session (PR #115 alone needed three iterations: CHANGELOG → modify-vs-delete
  → prettier-drift CI failure). The subagent handles five mechanical rules
  (CHANGELOG `Unreleased > Added` overlaps → keep both bullets; test additions
  to the same describe → keep both `it()` cases; non-overlapping code
  additions → keep both unless shared identifier; prettier drift → run
  `pnpm exec prettier --write` per resolved file before `git rebase --continue`;
  `--force-with-lease` only, refuses on `main`/`master`) and escalates four
  cases back to the operator (modify-vs-delete with port location guess;
  semantic conflict on overlapping lines; verification failure → no push;
  3-attempt iteration cap exceeded). The `/ai-sdlc rebase <pr>` slash command
  wraps the subagent: locates the worktree at `.worktrees/<task-id-lower>`
  (recreates from origin if missing), spawns the subagent, parses the
  structured JSON return, re-signs the attestation only when `contentHash`
  changed (using `sign-attestation.mjs --print-content-hash` as the
  AISDLC-94/101 oracle from AISDLC-102), and force-pushes with
  `--force-with-lease`. Test coverage: 30+ assertions in
  `agents/rebase-resolver.test.mjs` (frontmatter, hard rules, 5 mechanical
  rules, 4 escalation cases, return contract, fixture conflict scenarios for
  CHANGELOG overlap + test additions + modify-vs-delete + prettier drift +
  verification failure + force-with-lease refusal + attestation re-sign skip
  + iteration-cap escalation) plus 25+ assertions in
  `commands/rebase.test.mjs` (frontmatter, pipeline contract, hard rules,
  re-attestation flow, push step refuse-on-main, escalation handling).
- **Pre-sign rebase + conditional re-review** (`agents/execute-orchestrator.md`
  Step 10.5; `scripts/sign-attestation.mjs --print-content-hash`): inserted a
  new step between Step 9 (review iteration loop) and Step 10 (sign attestation)
  that fetches `origin/main` (with a 30s timeout), skips when `git merge-base
  --is-ancestor` reports no-op, otherwise rebases. The post-rebase
  `contentHash` (AISDLC-94 dual-hash oracle) decides whether reviewers'
  approval still binds (same hash → reuse) or whether 3 reviewers must
  re-spawn for one round (different hash → re-review). Rebase conflicts abort
  with `outcome: aborted (rebase-conflict)`; rebase-loop (main moves 3 times
  during attempts) aborts with `outcome: aborted (rebase-loop)` — the
  orchestrator never auto-resolves. Re-review iterations share Step 9's cap
  (max 2 dev iterations); cap exceeded → ships as `[needs-human-attention]`.
  Step 3 (worktree setup) ALSO fetches latest main first so the developer +
  reviewers run against current state from the start. Together with
  AISDLC-101 (verifier-side per-file delta hashing) this closes the
  AISDLC-93 / PR #102 attestation-invalidation gap as a defense-in-depth
  pair: producer-side Step 10.5 minimises *fresh* invalidation by signing
  the latest state; verifier-side AISDLC-101 accepts envelopes whose
  per-file blob SHA matches when sibling PRs merge between our push and our
  merge. The new `--print-content-hash` flag on `sign-attestation.mjs` is a
  read-only oracle used by Step 10.5 to compare pre/post rebase content
  without requiring a signing key. Tier 2 implementation (`pipeline-cli/src/steps/`)
  is deferred to AISDLC-100.5 (RFC-0012 Phase 5) since `pipeline-cli/`
  doesn't exist yet (RFC-0012 Phase 1 = AISDLC-100.1). Test coverage:
  `commands/execute.test.mjs` adds 9 new assertions on the orchestrator
  body for Step 10.5 prose markers and Step 3 fresh-base behaviour.
  (AISDLC-102)
- **RFC docs-drift CI gate** (`scripts/check-rfc-docs.mjs` +
  `scripts/check-rfc-docs.test.mjs` + `pnpm rfc:check` / `pnpm rfc:test`):
  enforces the `requiresDocs` convention defined in AISDLC-69.2. The script
  walks `spec/rfcs/RFC-*.md` (skipping the template), parses YAML
  frontmatter, and for every sign-off-locked RFC (`status: Approved`,
  `Implemented`, or `Final`) verifies that each surface listed in
  `requiresDocs` has at least one .md file under the corresponding
  `docs/<subdir>/` (per the schema enum: tutorial→tutorials,
  operator-runbook→operations, api-reference→api-reference,
  getting-started→getting-started, example→examples) that references the
  RFC by its `id`. RFCs flagged `deferredDocs: true` short-circuit with a
  warning that announces remaining days until the deadline (or `OVERDUE`).
  Pre-sign-off statuses (`Draft`, `Under Review`, `Rejected`, `Withdrawn`)
  are skipped — the operator process documented in `spec/rfcs/README.md`
  says docs land before requesting `Approved`, so we don't gate authoring.
  Wired into the root `pnpm test` chain so the check runs on every local
  test invocation. Operator follow-up: add `pnpm rfc:check` as an explicit
  step in `.github/workflows/ci.yml` (workflow files are blocked from the
  developer subagent, so this CHANGELOG entry is the handoff). Regression
  coverage: 46 node:test cases covering frontmatter parsing edge cases
  (CRLF, comments, malformed fences, inline empty list, block list,
  booleans), validation outcomes (Approved/Implemented/Final enforced;
  Draft/Under Review/Rejected/Withdrawn skipped; deferred warned;
  malformed rejected), recursive doc lookup, template skip, and CLI exit
  codes. (AISDLC-69.3)
- **CI-skip marker hygiene** (AISDLC-88) — three-layer prevention for the five
  GitHub Actions magic tokens (`(skip ci marker)`, `(ci skip marker)`, `(no ci marker)`,
  `(skip actions marker)`, `(actions skip marker)` — paren-quoted here to avoid
  triggering the parser this CHANGELOG entry documents) leaking into commit
  messages and silently disabling workflows.
  1. New `scripts/check-skip-ci-marker.sh` (`.husky/pre-push` wiring is an
     operator follow-up): scans every commit being pushed for the literal
     bracketed substrings (case-insensitive), prints a clear remediation
     message, and exits 1. Override via `AI_SDLC_SKIP_MARKER_GATE=1 git push`.
     Bot-author exemption: a commit authored by `ai-sdlc-ci-attestor[bot]`
     (production identity per `.github/workflows/ai-sdlc-review.yml`; legacy
     `github-actions[bot]` retained as a fallback in the script) AND subjected
     `chore(ci): sign review attestation*` passes (the documented AISDLC-87
     chore commit).
  2. New Hard Rule in `ai-sdlc-plugin/agents/developer.md` (Hard Rule 7) and
     `ai-sdlc-plugin/commands/execute.md` (post-AISDLC-98 the orchestrator
     subagent file is gone; the slash command body now hosts the rule). The
     agents must use the **paren-quoted form** when discussing these tokens
     in commit bodies. Backtick-wrapping does NOT defeat GitHub's
     literal-substring parser — only the bracket-free form is safe.
  3. The slash command body's Step 10 chore-commit body is now sed-sanitised
     before `git commit -m` as defense-in-depth (so even a leaked token in
     interpolated text gets rewritten before it can land).
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

### Removed

- **`hooks/quality-gate-stop.{sh,js,test.mjs}` + Stop-hook entries** that
  invoked it (AISDLC-108). The Claude `Stop` hook ran
  `quality-gate-stop.sh` at the end of every conversational turn,
  scanning `~/.claude/usage-data/tool-sequences.jsonl` (multi-MB across
  all sessions) and on miss exit-2'd to wake the model with a
  "Verifying governance compliance..." stderr blast. This was the wrong
  layer: build/test/lint verification belongs on the git lifecycle, not
  every turn. The canonical gate is `.husky/pre-push` →
  `scripts/check-coverage.sh` (runs `pnpm -r test:coverage` workspace-wide
  + enforces the 80% codecov patch threshold), which already runs at the
  right boundary and blocks the push not the conversation. Per-turn false
  positives during long orchestrator runs were the trigger for removal.
  Removed entries from the bundled `ai-sdlc-plugin/plugin.json` and
  `ai-sdlc-plugin/.claude-plugin/plugin.json` Stop arrays; the deferred
  coverage check (`hooks/deferred-coverage-check.sh`, asyncRewake) and
  the Haiku governance verifier remain because they don't duplicate the
  pre-push gate. Project-level `.claude/settings.json` Stop entry must
  also be stripped — handled by the operator (file is outside the
  developer subagent's write scope).

### Documentation

- **RFC-0006 retroactive user docs** (`docs/tutorials/design-system-getting-started.md`,
  `docs/operations/design-system-operator-runbook.md`,
  `docs/api-reference/design-system.md`): authored the three doc surfaces
  declared in RFC-0006's `requiresDocs` frontmatter. The tutorial (~1.3k
  words, three worked examples) walks a frontend team through declaring a
  `DesignSystemBinding`, wiring three quality gates, and operating the
  design-token-cascade / compose-or-justify / token-deletion-blocked flows
  end to end. The operator runbook (~1.2k words) covers the daily / weekly /
  monthly cadence for the design system maintainer + pipeline operator
  (rotating MCP bearer tokens, approving token migrations, refreshing
  baselines, tuning `cascadeThreshold` and review SLA) plus an
  RFC-0006-specific event triage table. The api-reference doc covers the
  three RFC-0006 adapter interfaces (`DesignTokenProvider`,
  `ComponentCatalog`, `VisualRegressionRunner`) and their project-owned
  reference implementations (`tokens-studio`, `figma-variables`,
  `storybook-mcp`, `playwright-visual`). RFC-0006 frontmatter
  `deferredDocs: true` removed (no longer applicable); `updated: 2026-04-30`
  bumped. Closes the canonical "missing docs" example that motivated
  AISDLC-69. (AISDLC-69.4)

- **RFC `requiresDocs` frontmatter convention** (`spec/rfcs/RFC-0001-template.md`,
  `spec/rfcs/README.md`, `spec/schemas/rfc.schema.json`): every RFC now
  carries a YAML frontmatter block with `id` / `title` / `status` / `author` /
  `created` / `updated` / `requiresDocs` (and optional `deferredDocs` +
  `deferredDocsDeadline`). The `requiresDocs` field is a closed enum
  (`tutorial`, `operator-runbook`, `api-reference`, `getting-started`,
  `example`) that declares which user-facing doc surfaces the RFC requires
  — the docs-drift CI gate (AISDLC-69.3) will enforce that each declared
  surface has at least one doc file referencing the RFC by ID. RFCs 0002,
  0003 (both 0003a and 0003b), 0004, 0005, 0006, 0008, and 0010 migrated
  from markdown-bold-style status (`**Status:** Draft`) to YAML; the
  bold-status block is preserved in the body for human readability but
  the frontmatter is the source of truth for tooling. The README RFC index
  table is refreshed to reflect actual statuses (RFC-0006 / RFC-0008 are
  `Final`, not `Draft`) and a new `requiresDocs` column. The stale
  RFC-0007 / RFC-0009 rows are documented as reserved/withdrawn slots.
  RFC-0006 declares `deferredDocs: true` with a `2026-07-31` deadline —
  AISDLC-69.4 tracks the retroactive doc authoring. (AISDLC-69.2)

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

- **`pnpm --filter @ai-sdlc/dogfood watch` migrated to `executePipeline()`
  from `@ai-sdlc/pipeline-cli`** (AISDLC-100.5, RFC-0012 Phase 5) — the
  watch CLI in `dogfood/src/cli-watch.ts` no longer wraps
  `@ai-sdlc/orchestrator`'s reconciler-driven `startWatch`. Each `--issue`
  is now driven directly through the shared Tier 2 composite from the
  pipeline-cli package, which runs Steps 0-13 against a `SubagentSpawner`
  selected per `--spawner auto|shell|sdk|mock` (default `auto` →
  `defaultSpawner()` resolution per RFC §8.3 — `ShellClaudePSpawner`
  preferred when `claude` CLI is on PATH, falling back to
  `ClaudeCodeSDKSpawner` when `ANTHROPIC_API_KEY` is set). Behavior parity
  is intentionally narrow: reconciler retry/backoff, Pipeline-resource
  routing, admission gating, autonomy enforcement, audit logging, OTEL
  instrumentation, and provenance attestation are NOT yet exposed by
  pipeline-cli — those code paths still live in the orchestrator-driven
  `pnpm --filter @ai-sdlc/dogfood execute` CLI (`cli.ts`, unchanged) and
  Phase 6 follow-up tracks restoring them on top of `executePipeline()`.
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
