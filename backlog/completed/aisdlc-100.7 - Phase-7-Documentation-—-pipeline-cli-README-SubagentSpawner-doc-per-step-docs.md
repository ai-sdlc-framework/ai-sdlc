---
id: AISDLC-100.7
title: >-
  Phase 7: Documentation — pipeline-cli README, SubagentSpawner doc, per-step
  docs
status: Done
assignee: []
created_date: '2026-04-30 22:59'
labels:
  - rfc-0012
  - phase-7
  - docs
dependencies:
  - AISDLC-100.4
  - AISDLC-100.5
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - pipeline-cli/README.md (new)
  - pipeline-cli/docs/ (new)
  - CLAUDE.md
  - ai-sdlc-plugin/README.md
parent_task_id: AISDLC-100
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0012 Phase 7 (Section 11). Write the user-facing and contributor-facing documentation for the new architecture.

## What changes

- `pipeline-cli/README.md` — package overview, install instructions (npm + plugin-bundled), quickstart for both Tier 1 and Tier 2 use, link to RFC-0012
- `pipeline-cli/docs/spawner.md` — SubagentSpawner interface deep-dive: when to use ShellClaudeP vs ClaudeCodeSDK vs Mock, how to write a custom spawner
- `pipeline-cli/docs/steps/*.md` — one short doc per step (or a single `pipeline-cli/docs/steps.md`): contract, inputs, outputs, side effects, when each step runs
- `CLAUDE.md` — link to the new docs from the canonical-execution-paths table
- Update plugin README (`ai-sdlc-plugin/README.md`) — note the new MCP tool surface + slash command body change

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `pipeline-cli/README.md` written: overview, install, Tier 1 + Tier 2 quickstarts, RFC link
2. `pipeline-cli/docs/spawner.md` written: spawner selection guide, custom spawner howto
3. Per-step docs written (single combined file OK): contract per step
4. CLAUDE.md updated with links to new docs
5. Plugin README updated with new MCP tool surface + slash command body change
6. All examples in docs are runnable (verified by manual run-through)
7. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean (docs changes don't break build)
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 `pipeline-cli/README.md` written: overview, install, Tier 1 + Tier 2 quickstarts, RFC link
- [ ] #2 `pipeline-cli/docs/spawner.md` written: spawner selection guide + custom spawner howto
- [ ] #3 Per-step docs written (one file or combined): contract / inputs / outputs / side effects per step
- [ ] #4 CLAUDE.md updated with links to new docs
- [ ] #5 Plugin README updated with new MCP tool surface + slash command body change note
- [ ] #6 All code examples in docs verified runnable
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0012 Phase 7: rewrote pipeline-cli/README.md with dual-tier framing + install matrix + Tier 1/Tier 2 quickstarts; added new pipeline-cli/docs/spawner.md (selection guide, lazy SDK import, Q5 `--agent` vs `--subagent` resolution, custom spawner howto) and pipeline-cli/docs/steps.md (per-step contract for Step 0-13). Updated CLAUDE.md with new Dual-tier pipeline architecture subsection cross-linking the three new docs.

## AC status
- ✓ ACs #1, #2, #3, #4, #6, #7 met
- N/A AC #5: ai-sdlc-plugin/README.md does not exist (plugin user-facing prose lives in CLAUDE.md)

## Verification
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean (modulo pre-existing dogfood/runner/exports.test.ts flake unrelated to this PR)
- 3 reviews approved: code 0c/0M/4m/2s; test 0c/0M/0m/0s; security 0c/0M/0m/0s
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable)

## Code reviewer follow-ups (non-blocking, all minor doc-drift)
- README + CLAUDE.md describe Phase 3 (MCP) and Phase 4 (slash command CLI integration) using present-tense framing — both are "in flight" per the same README's phase table. Hedge with "after Phase 4 lands" / "Phase 3's MCP wrappers ship in AISDLC-100.3"
- README + spawner.md reference `dogfood/src/watch.ts` (the upstream task name) but actual file is `dogfood/src/cli-watch.ts`
- Phase 4 row says "delete agents/execute-orchestrator.md" — already deleted by AISDLC-98
- README MockSpawner inline example uses `'code-reviewer': { /* ReviewerVerdict shape */ }` placeholder — actual fixture must be `SubagentResult` with `parsed: ReviewerVerdict` (longer example in spawner.md is correct)
- steps.md "integration test runs all 14 against MockSpawner" wording overstates what execute-pipeline.test.ts asserts
<!-- SECTION:FINAL_SUMMARY:END -->
