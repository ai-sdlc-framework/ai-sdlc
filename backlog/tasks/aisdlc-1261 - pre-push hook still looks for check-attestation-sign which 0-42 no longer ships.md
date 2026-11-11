---
id: AISDLC-1261
title: 'Adopter `.husky/pre-push` still looks for `scripts/check-attestation-sign.sh`, which 0.42.0 no longer ships; every push prints the "Install the ai-sdlc Claude Code plugin" hint'
status: To Do
assignee: []
created_date: '2026-11-11'
labels:
  - plugin
  - pipeline-cli
  - pre-push
  - adopter
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/execute.ts
  - ai-sdlc-plugin/README.md
  - ai-sdlc-plugin/scripts/drop-attestation-chores.sh
  - docs/operations/attestation-reference.md
priority: medium
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2622). Verified: `ai-sdlc-plugin/scripts/` has no check-attestation-sign.sh, while the README (lines 213-225) and the pre-push installer comments in execute.ts still reference it.'
---

## Description

**Gap (issue #2622, observation 2).** RFC-0061 / DEC-0284 removed envelope signing; `check-attestation-sign.sh` left the plugin. The pre-push hook that `ai-sdlc init` / the installer wrote for adopters still calls it, and the fallback branch prints "Install the ai-sdlc Claude Code plugin, or set CLAUDE_PLUGIN_ROOT" on every push. The hook does not fail, so the noise hides real messages, and `ai-sdlc-plugin/README.md` still documents the script.

**Shape.** The installer writes a pre-push hook with no reference to the removed script; a re-run of `ai-sdlc init` (or `doctor --fix`) rewrites a hook that still references it; `doctor` reports a stale hook; the README section is removed or rewritten for the verdict-record flow. The hook must state how it handles `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` (AISDLC-1129).

## Fix

**Five-step review.**
1. Requirement questioned: does the adopter pre-push need any attestation step at all after DEC-0284? Answer in the task: it does not; only the task-moved check and the dark-code gate remain.
2. Deleted: the `check-attestation-sign.sh` lookup and its install hint.
3. Simplified: one hook template, generated from the manifest `init` already reads.
4. Accelerated: silent pushes for adopters.
5. Automated: `doctor` detects the stale line; test with a fixture hook.

## Acceptance Criteria

- [ ] AC-1: the hook template written by `ai-sdlc init` contains no `check-attestation-sign` reference; snapshot test.
- [ ] AC-2: `ai-sdlc doctor` reports `pre-push: stale attestation-sign reference` for a hook that still has it, and `--fix` rewrites it; test with a fixture `.husky/pre-push`.
- [ ] AC-3: the comments in `pipeline-cli/src/cli/execute.ts` and the `ai-sdlc-plugin/README.md` section describing the script are removed or rewritten for the verdict-record flow (RFC-0061).
- [ ] AC-4: the rewritten hook declares its handling of `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` (AISDLC-1129) in the PR body.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
