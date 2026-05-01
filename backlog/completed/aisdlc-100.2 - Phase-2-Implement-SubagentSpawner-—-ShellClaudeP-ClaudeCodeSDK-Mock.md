---
id: AISDLC-100.2
title: 'Phase 2: Implement SubagentSpawner — ShellClaudeP + ClaudeCodeSDK + Mock'
status: Done
assignee: []
created_date: '2026-04-30 22:58'
labels:
  - rfc-0012
  - phase-2
  - pipeline-cli
  - spawner
dependencies:
  - AISDLC-100.1
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - pipeline-cli/src/runtime/
parent_task_id: AISDLC-100
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0012 Phase 2 (Section 11). Implement the three SubagentSpawner implementations per RFC §8.

## What changes

- `pipeline-cli/src/runtime/subagent-spawner.ts` — interface definition (already added in Phase 1, but re-confirm contract)
- `pipeline-cli/src/runtime/shell-claude-p-spawner.ts` — Tier 2 default. Shells out to `claude -p "<prompt>" --cwd <opts.cwd> --subagent <opts.type>`. Uses operator's logged-in Claude Code session (subscription auth). Per Q5 in RFC §15: confirm `--subagent <type>` flag exists OR design alternative (e.g., prompt prefix that selects the system prompt).
- `pipeline-cli/src/runtime/claude-code-sdk-spawner.ts` — Tier 2 alternative. Uses `@anthropic-ai/claude-code` SDK programmatically with API key auth.
- `pipeline-cli/src/runtime/mock-spawner.ts` — for unit/integration tests. Returns canned fixture results.
- `defaultSpawner()` helper that picks ShellClaudeP if `claude` CLI available, else ClaudeCodeSDK if `ANTHROPIC_API_KEY` set, else throws.
- Unit tests for each spawner (mock the underlying call mechanism)

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `SubagentSpawner` interface in `pipeline-cli/src/runtime/subagent-spawner.ts` matches RFC §8.1
2. `ShellClaudePSpawner` shells out to `claude -p` correctly; verify subscription auth path works against operator's session (manual verification on dev machine)
3. `ClaudeCodeSDKSpawner` uses `@anthropic-ai/claude-code` SDK with API key; verify against test API key
4. `MockSpawner` returns canned fixtures, used by integration tests
5. `defaultSpawner()` helper resolves the right spawner per environment
6. Unit tests pass for each spawner (mocking the underlying call)
7. Integration test: run full `executePipeline()` against MockSpawner end-to-end (uses Phase 1's composite entry)
8. Document the `--subagent <type>` flag handling — if it doesn't exist, document the alternative approach (RFC Q5)
9. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 `SubagentSpawner` interface matches RFC §8.1 contract
- [ ] #2 `ShellClaudePSpawner` shells out to `claude -p`; subscription auth verified manually against operator's session
- [ ] #3 `ClaudeCodeSDKSpawner` uses `@anthropic-ai/claude-code` SDK with API key
- [ ] #4 `MockSpawner` returns canned fixtures for tests
- [ ] #5 `defaultSpawner()` helper resolves correct spawner per environment (subscription > API key > error)
- [ ] #6 Unit tests per spawner mocking the underlying call mechanism
- [ ] #7 Integration test runs `executePipeline()` end-to-end with MockSpawner
- [ ] #8 Document `--subagent <type>` handling (or alternative approach if flag doesn't exist)
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

RFC-0012 Phase 2: production `SubagentSpawner` implementations. AISDLC-100.1 (Phase 1) shipped the interface + MockSpawner. This task ships:
- **`ShellClaudePSpawner`** — Tier 2 default. Shells out to `claude --print --output-format json --permission-mode bypassPermissions --agent <type> <prompt>` via `child_process.spawn` (argv-style, no shell). Subscription auth via operator's logged-in Claude Code session.
- **`ClaudeCodeSDKSpawner`** — Tier 2 alternative. Lazy-imports `@anthropic-ai/claude-code` SDK with API-key auth. Lazy import keeps subscription consumers from carrying ~50MB of SDK code.
- **`defaultSpawner()`** — async resolver: PATH-which `claude` → `ANTHROPIC_API_KEY` → throw. Both detection mechanisms injectable for testability.

**Q5 from RFC §15 resolved**: actual CLI flag is `--agent <type>` (NOT `--subagent <type>` as RFC sketched). Empirically verified against operator's installed CLI; documented in spawner JSDoc + README.

Unblocks Phase 3 (MCP tools), Phase 4 (commands/execute.md refactor to thin wrapper), Phase 5 (watch.ts migration), Phase 7 (docs).

## Changes

- `pipeline-cli/src/runtime/shell-claude-p-spawner.{ts,test.ts}` — new ShellClaudeP implementation + 19 tests
- `pipeline-cli/src/runtime/claude-code-sdk-spawner.{ts,test.ts}` — new ClaudeCodeSDK implementation + 24 tests
- `pipeline-cli/src/runtime/default-spawner.{ts,test.ts}` — new resolver + 8 tests
- `pipeline-cli/src/runtime/index.ts` — barrel re-exports
- `pipeline-cli/src/index.test.ts` — +6 public-surface assertions for new exports
- `pipeline-cli/src/execute-pipeline.test.ts` — +4 integration tests (3 defaultSpawner picker scenarios + 1 e2e smoke through resolved spawner)
- `pipeline-cli/README.md` — Status section updated with Q5 resolution + spawner selection guide

## AC status

- ✓ All 9 ACs met

## Design decisions

- **Lazy SDK import** (`await import('@anthropic-ai/claude-code')` with string-literal package name) — subscription path doesn't carry SDK weight; clear "SDK not installed" error when missing. String literal (not interpolated) prevents env-var injection of import path.
- **`spawn` field/method shadowing fix** — original ShellClaudePSpawner had a `spawn` METHOD (SubagentSpawner contract) AND a `spawn` private field (injected child_process.spawn). Field shadowed method. Renamed field to `processSpawner` with explanatory comment at lines 114-116.
- **`bypassPermissions` permission mode hardcoded** in `buildArgv` — not exposed via SpawnOpts so untrusted callers can't toggle it. Justified for unattended Tier 2 spawner where there's no human at the keyboard; PreToolUse hook + worktree write-fence remain the actual security boundary.
- **No `--cwd` flag** — claude CLI doesn't expose one. Cwd is set via `child_process.spawn`'s `options.cwd` at the OS level. Documented in JSDoc.
- **Async `defaultSpawner()`** — `which`-style detection is async. All callers await; integration smoke test verifies.
- **`defaultTimeoutMs: 30 * 60 * 1000`** (30 min default) — unattended pipeline calls can be long. Per-call override supported.

## Verification

- `pnpm build` — clean across all 9 workspace packages
- `pnpm --filter @ai-sdlc/pipeline-cli test` — **218/218** (was 157, +61 new)
- `pnpm --filter @ai-sdlc/pipeline-cli test:coverage` — 94.6% lines / 84.4% branch / 98.46% funcs (well above 80% threshold)
- `pnpm test` (full workspace) — clean across all packages, no regressions to pre-existing 157 baseline
- `pnpm lint`, `pnpm format:check` — clean
- Manual: `node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs --help` lists all 13 step subcommands
- 3 reviews approved (code 0c/0M/2m/2s; test 0c/0M/0m/2s; security 0c/0M/0m/0s); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up (deferred from review, all non-blocking)

- **Code minor**: `withTimeout()` in `claude-code-sdk-spawner.ts:313` rejects the outer promise but doesn't abort the underlying SDK invoker. Wire AbortController through SDKInvoker contract so timed-out invokes can cancel. Bounded by 30-min default.
- **Code minor**: `normaliseRunAgentResponse:300` — `typeof null === 'object'` so `parsed` could be `null` (vs `undefined`) when `r.result === null`. Add explicit `r.result !== null` guard or document as deliberate sentinel.
- **Code suggestion**: rename public option `spawn?: ProcessSpawner` to `processSpawner?: ProcessSpawner` to match the renamed internal field — eliminates the shadowing footgun for future maintainers.
- **Code suggestion**: `defaultSpawner({shell: {binary: '/opt/bin/claude'}})` — when an absolute path is given, `which` validation can be unreliable; consider `fs.access(bin, fs.constants.X_OK)` for absolute paths and `which` for bare names.
- **Test suggestion**: explicit regression test that `new ShellClaudePSpawner({ spawn: fakeFn })` does NOT result in `spawner.spawn === fakeFn` — locks the rename intent. Currently implicit via every passing test.
- **Test suggestion**: bump `defaultTimeoutMs: 1` in timeout test to `5` to reduce flake risk on slow runners.
<!-- SECTION:FINAL_SUMMARY:END -->
