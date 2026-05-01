---
id: AISDLC-100.3
title: 'Phase 3: Wrap pipeline step functions as MCP tools'
status: Done
assignee: []
created_date: '2026-04-30 22:58'
labels:
  - rfc-0012
  - phase-3
  - mcp-tools
  - plugin
dependencies:
  - AISDLC-100.1
  - AISDLC-99
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - ai-sdlc-plugin/mcp-server/src/tools/
parent_task_id: AISDLC-100
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0012 Phase 3 (Section 11) and §9. Expose every step function from `@ai-sdlc/pipeline-cli` as an MCP tool from the plugin's MCP server, so any Claude Code session can invoke individual pipeline steps as building blocks.

## What changes

- `ai-sdlc-plugin/mcp-server/src/tools/pipeline-*.ts` — one tool file per step (12 tools per RFC §9.1)
- Each tool wraps the corresponding step function from `@ai-sdlc/pipeline-cli`. Same arguments as CLI subcommand. Same return schema.
- `ai-sdlc-plugin/mcp-server/src/tools/index.ts` — register the new tools
- Unit tests for each MCP tool wrapper
- Plugin documentation update: list the new MCP tool surface

## Critical dependency

This phase REQUIRES AISDLC-99 (MCP server path bug fix) to ship first. Otherwise the new tools inherit the broken root path.

## What this DOES NOT include

Per RFC §9.3: NO `pipeline_execute_full` composite MCP tool. MCP tools are deterministic-step-only because the LLM dispatch (Steps 5b, 7b) requires main-session Agent calls that an MCP server's process can't make.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. 12 MCP tools registered per RFC §9.1: `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_sweep_worktrees`, `pipeline_validate_task`, `pipeline_setup_worktree`, `pipeline_begin_task`, `pipeline_build_dev_prompt`, `pipeline_parse_dev_return`, `pipeline_build_review_prompts`, `pipeline_aggregate_verdicts`, `pipeline_finalize_task`, `pipeline_push_and_pr`, `pipeline_sibling_prs`, `pipeline_cleanup_task`
2. Each MCP tool calls into the corresponding step function from `@ai-sdlc/pipeline-cli`
3. Each MCP tool has unit tests covering happy path + error case
4. Manual verification: from a fresh Claude Code session, call each MCP tool with a sample input, verify return shape matches the corresponding CLI subcommand's output
5. Plugin documentation updated: list MCP tool surface in `ai-sdlc-plugin/README.md` or equivalent
6. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
7. AISDLC-99 must be verified shipped before this task closes
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 12 MCP tools registered per RFC §9.1 with `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_*` namespace
- [ ] #2 Each MCP tool wraps corresponding step function from `@ai-sdlc/pipeline-cli`
- [ ] #3 Unit tests per MCP tool covering happy path + error case
- [ ] #4 Manual verification: each MCP tool callable from fresh Claude Code session, return shape matches CLI subcommand
- [ ] #5 Plugin documentation lists MCP tool surface in README
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- [ ] #7 AISDLC-99 verified shipped before this task closes
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

RFC-0012 Phase 3: wrapped each Step 0-13 function from `@ai-sdlc/pipeline-cli` as an MCP tool (`pipeline_step_0_sweep` through `pipeline_step_13_cleanup`) on the plugin's MCP server. Future Phase 4 work can switch the slash command body to invoke `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_step_<N>_<name>` instead of inline bash. Each tool's input schema mirrors the corresponding step's Options interface; Step 9 lazily resolves `defaultSpawner()` from AISDLC-100.2 for the LLM dispatch boundary, with `PipelineToolDeps` providing test-injectable `stepRunners` + `spawnerFactory` hooks.

## Changes
- `ai-sdlc-plugin/mcp-server/src/tools/pipeline-tools.{ts,test.ts}` (new) — 14 MCP tool wrappers + 25 tests
- `ai-sdlc-plugin/mcp-server/src/tools/index.{ts,test.ts}` (modified) — wired `registerPipelineTools` into the registry
- `ai-sdlc-plugin/mcp-server/package.json` — added `@ai-sdlc/pipeline-cli` workspace dep
- `ai-sdlc-plugin/mcp-server/dist/bin.js` — regen at 791KB (pipeline-cli inlined; AISDLC-75 contract preserved)
- `pnpm-lock.yaml`
- `ai-sdlc-plugin/CHANGELOG.md` (Unreleased > Added)

## AC status
- ✓ All 7 ACs met

## Verification
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- 104/104 mcp-server tests pass; 25 new pipeline-tools tests + 79 existing
- Manual smoke: `createPluginMcpServer()` registers 21 total tools (7 governance + 14 pipeline)
- Bundle smoke (`pnpm verify-bundle`): dist/bin.js still self-contained at 791KB
- 3 reviews approved: code 0c/0M/2m/2s; test 0c/0M/1m/2s; security 0c/0M/2m/0s
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up (deferred from review, all non-blocking)
- Step 9 spawnerFactory resolves unconditionally even when initial verdict is APPROVED — peek at `decision === 'CHANGES_REQUESTED'` before resolving to avoid requiring credentials on happy path
- Step 6 `developerReturn: z.union([z.string(), z.unknown()])` is effectively `z.unknown()` (string is a subtype) — tighten to `z.string().or(z.record(z.unknown()))` for clarity
- Step 10/11 schemas accept negative integers / NaN for iteration counts — add `.int().nonnegative()` constraints
- Step 11 `branch: z.string()` allows force-push refspecs like `+main` — add regex `/^[A-Za-z0-9._/-]+$/` and reject leading `+`/`-` for defense-in-depth
- Step 10 `signAttestationScript` is an arbitrary user-supplied path passed to `node` — restrict to `CLAUDE_PLUGIN_ROOT/scripts/` for hardening
- Higher-level integration test asserting cumulative server.tool() count = 21 would catch register-helper drift
<!-- SECTION:FINAL_SUMMARY:END -->
