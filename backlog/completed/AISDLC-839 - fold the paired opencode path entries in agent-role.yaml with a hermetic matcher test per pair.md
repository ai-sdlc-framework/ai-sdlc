---
id: AISDLC-839
title: >-
  fold the paired opencode path entries in agent-role.yaml with a hermetic matcher test per pair
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - governance
  - hooks
dependencies: []
references:
  - .ai-sdlc/agent-role.yaml
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - .ai-sdlc/gates.yaml
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`.ai-sdlc/agent-role.yaml` lines 45 to 50 list `opencode.json`, `opencode.jsonc`, `.opencode/**` and their `**/` twins (origin: a task that added the opencode block); lines 63 to 64 list `git branch -D*` and `git branch -d*` (project baseline). Each entry is a separate registry gate (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 row D13). Paired entries that the matcher treats identically are duplicates.

**Five-step review (requirements first).** Requirement questioned: "list both the bare and the `**/` form of each path" (the opencode block task), set without checking the matcher. The operator answered DEC-0106 on 2026-10-11: fold only what the matcher provably treats identically, with a hermetic test per folded pair asserting every original string is still blocked; the `git branch -d/-D` pair stays as two entries unless `enforce-blocked-actions.js` already supports a character class, and the matcher is NOT extended for this. Delete: the redundant twin entries proven redundant. Simplify: one pattern per proven pair. Accelerate: not applicable. Automate: the per-pair hermetic test is the guard.

## Fix

1. Read the matcher in `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (and the path matcher the PreToolUse hook uses for `blockedPaths`) and write, for each candidate pair, a test first: for `opencode.json` vs `**/opencode.json`, `opencode.jsonc` vs `**/opencode.jsonc` and `.opencode/**` vs `**/.opencode/**`, assert whether `**/x` already matches the bare top-level `x`.
2. Fold a pair into one pattern only when the test proves the folded pattern blocks every original string (top-level and nested); leave unproven pairs as two entries and state which in the PR body. Do not modify the matcher. Leave `git branch -d*` / `-D*` as two entries unless the matcher already supports a character class.
3. Add the tests next to the hook tests (`node --test ai-sdlc-plugin/hooks/`), one per folded pair, asserting every original string stays blocked.
4. `.ai-sdlc/gates.yaml`: delete the registry entries of folded patterns; keep `scripts/check-gate-registry.test.mjs` green. Mirror the same edits in any template copy of `agent-role.yaml` (check with `rg "opencode.jsonc"` under `orchestrator/src/cli/commands/` and `ai-sdlc-plugin/`).
5. This changes a governance control file: the PR body states which pairs were folded and quotes the test that proves equivalence.

**Velocity impact.** Neutral to positive: fewer duplicate registry entries to audit; no block is removed because every fold is test-proven.

Authority: DEC-0106 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Every folded pair in `.ai-sdlc/agent-role.yaml` has a hermetic test proving each original string is still blocked, and `node --test ai-sdlc-plugin/hooks/` passes
- [ ] #2 Pairs the matcher does not provably treat identically are unchanged and named in the PR body; `enforce-blocked-actions.js` is not modified
- [ ] #3 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #4 Any template or copy of `agent-role.yaml` carrying the same entries is updated identically
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
