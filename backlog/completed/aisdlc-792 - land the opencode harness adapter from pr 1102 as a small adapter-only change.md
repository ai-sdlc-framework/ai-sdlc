---
id: AISDLC-792
title: >-
  Land the opencode harness adapter from PR #1102 as an adapter-only change (orchestrator/src/harness/adapters/opencode.ts + tests)
status: Done
assignee: []
created_date: '2026-10-10'
labels:
  - harness
  - opencode
  - dec-0081
dependencies: []
references:
  - orchestrator/src/harness/adapters/
  - docs/operations/copilot-spawner.md
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implements DEC-0081 (operator ruling 2026-10-10, option `split-adapter-only`). PR #1102 (the opencode v2 work, branch `feat/aisdlc-660-opencode-v2-adaptation`, head e0b6d4e6) bundled an opencode v2 harness adapter with a dispatch runner, `.opencode/` agents and plugins, `opencode.json`, five contrib runners and three runbooks: 7,567 lines over 30 files, now 186 commits behind main with two open CodeQL findings (`js/regex-injection` in `contrib/runners/opencode/runner.mjs:533`, `js/insufficient-password-hash` in `orchestrator/src/harness/adapters/opencode.ts:93`). The operator closes #1102; this task re-lands only the adapter, following the adapter-first pattern of the Copilot (AISDLC-429) and Codex bridges.

Start from a fresh branch off main. Take `orchestrator/src/harness/adapters/opencode.ts` and its tests from the #1102 branch as reference material (read them from `git show e0b6d4e6:<path>`; do not cherry-pick the commits), re-express them against the current harness-adapter interface in `orchestrator/src/harness/adapters/`, and resolve the `js/insufficient-password-hash` finding (use a proper hash or remove the hashing). Nothing under `.opencode/`, `opencode.json`, `contrib/` or new workflow/config files is in scope: those paths are governance-blocked for agents and need an operator decision of their own. One short section in the harness docs (where the Copilot and Codex adapters are described) says opencode is adapter-only and how to select it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] `orchestrator/src/harness/adapters/opencode.ts` exists, implements the current adapter interface, and is registered the same way the Copilot and Codex adapters are.
- [x] Unit tests cover the adapter's request/response mapping and error paths at the same depth as the sibling adapters; `pnpm --filter @ai-sdlc/orchestrator test` passes.
- [x] CodeQL reports no new alerts on the PR (the `insufficient-password-hash` pattern from #1102 is not reproduced).
- [x] The PR touches nothing under `.opencode/`, `opencode.json`, `contrib/`, `.github/` or `.ai-sdlc/`.
- [x] Docs: the harness adapter section names opencode as adapter-only and cites DEC-0081.

## Notes

Reference branch: `feat/aisdlc-660-opencode-v2-adaptation` (PR #1102, to be closed by the operator). No backlog task file ever existed for that branch; this task supersedes it.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Re-landed the opencode harness adapter as adapter-only (DEC-0081): capabilities, `>=2.0.0` version probe, scrypt-derived account id (replaces the fast-hash pattern flagged as `js/insufficient-password-hash` on #1102), model listing, and a stubbed `invoke` like Codex.

## Changes
- `orchestrator/src/harness/adapters/opencode.ts` (new): the adapter.
- `orchestrator/src/harness/adapters/opencode.test.ts` (new): capabilities, version parsing, account-id derivation and precedence, probe caching, model chain, invoke delegation and error.
- `orchestrator/src/harness/index.ts`, `orchestrator/src/index.ts`, `registry.test.ts` (modified): export and register.
- `docs/operations/adapter-authoring.md` (modified): opencode named adapter-only, cites DEC-0081.

## Design decisions
- **scrypt with a fixed domain-separation salt**: the id must be stable across runs, and scrypt is password-grade so CodeQL does not flag it.

## Verification
- `pnpm build` clean; orchestrator tests 5059 passed; `pnpm lint` clean; `pnpm format:check` clean.
- 3 reviewers approved (code, test Claude-native after Codex quota; security).

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
