---
id: AISDLC-761
title: >-
  Pin a model on every plugin command and agent; haiku for relays and review probes
status: Done
assignee: []
created_date: '2026-10-08'
labels:
  - token-cost
  - plugin
dependencies: []
references:
  - ai-sdlc-plugin/commands/
  - ai-sdlc-plugin/agents/
  - CLAUDE.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

22 of 23 commands and 5 agents (review-executor, code-reviewer-codex, test-reviewer-codex, refinement-reviewer, rebase-resolver, ci-conflict-resolver) carry `model: inherit`, so a relay run from a Fable or Opus session pays that rate (the 2026-05-30 incident class). Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. Pin haiku on relay commands (version, doctor, hierarchy, cleanup, pipeline-status, triage render, import-spec, rfc-init, init-signing-key) and on review-executor.
2. Pin sonnet on the resolvers, refinement-reviewer and the codex wrappers; keep developer on sonnet and security-reviewer on opus.
3. Add a test that fails when a command or agent file has no `model:` or has `inherit`.
4. Update the CLAUDE.md section 'Subagent model defaults'.

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] AC-1: No command or agent file under ai-sdlc-plugin carries `model: inherit` or lacks `model:`.
- [x] AC-2: The listed relay commands and review-executor pin haiku; resolvers, refinement-reviewer and codex wrappers pin sonnet.
- [x] AC-3: The new test fails on a file with no model or with inherit.
- [x] AC-4: CLAUDE.md subagent model defaults match the pins.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Every command and agent under `ai-sdlc-plugin` now pins a model; none is `inherit` or unpinned. Relay commands and `review-executor` pin haiku, orchestration commands, resolvers, `refinement-reviewer` and the codex wrappers pin sonnet, `developer` stays sonnet and `security-reviewer` stays opus. A new test fails on a missing or `inherit` model.

## Changes
- `ai-sdlc-plugin/commands/*.md`, `ai-sdlc-plugin/agents/*.md` (modified): `model:` frontmatter pinned.
- `ai-sdlc-plugin/commands/model-pins.test.mjs` (new): checks every file has a non-inherit model and the AC-2 pins; self-tests reject a missing model and `inherit`.
- `package.json` (modified): wires the test as `test:plugin-model-pins-gate` into `pnpm test`.
- `CLAUDE.md`, `ai-sdlc-plugin/README.md` (modified): model defaults match the pins.
- Existing plugin tests that asserted `inherit` updated.

## Design decisions
- **Sonnet for orchestration commands** (execute, orchestrator-tick, dispatch-worker, executor, operator-dispatch, planner, execute-parallel, fix-pr, review-pr, detect-patterns): they do real orchestration, so haiku is too small, but they must not inherit an Opus/Fable rate.
- **Haiku for status/cleanup commands** (pipeline-status, execute-parallel-status, execute-parallel-cleanup): relays only.

## Verification
- `pnpm build` — clean
- `pnpm test` — model-pins test 76/76; full plugin command/agent suite 513 pass, 5 fail identically on unmodified main
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 2 reviewers approved (code, security); classifier scoped out testing

## Follow-up
- declined: the 5 pre-existing plugin test failures on main (rebase-resolver CHANGELOG rule, execute Step 7c fixed-sonnet default, no-bare-paths, operator-dispatch task-id text, orchestrator-tick write-manifest) are out of scope; these plugin test files are not wired into `pnpm test`
<!-- SECTION:FINAL_SUMMARY:END -->
