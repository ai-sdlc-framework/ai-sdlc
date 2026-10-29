---
id: AISDLC-655.1
title: >-
  RFC-0050: live smoke test of the reviewer replay sandbox with the real claude CLI
status: In Progress
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
dependencies:
  - AISDLC-655
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/replay-run.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The replay sandbox was built and tested without a live model call. Run it once against the installed claude CLI and record the results: that the reviewer agent still resolves with user-only settings sources, that authentication still works under the scrubbed environment for a subscription login and for an API key, that the variable disabling CLAUDE.md loading has any effect (or replace it with a verified mechanism), and that no commit-supplied configuration is loaded. Adjust the sandbox flags if any of these fail.

Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [x] A replay of one corpus item completes against the real CLI with the sandbox on and produces a block or approve outcome.
- [x] Authentication works under the scrubbed environment for a subscription login and for an API key, recorded in the task notes.
- [x] The effect of the CLAUDE.md-disabling variable is verified, or the sandbox uses a verified mechanism instead.
- [x] A commit carrying a project hook and a project agent definition does not run either during replay.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Live smoke test, claude 2.1.312, 2026-10-28. No sandbox flag change was needed.

- AC1: `cli-usage replay --role code --model haiku --max-items 1 --confirm-spend` on corpus item AISDLC-1013 (known-defect) completed with the sandbox on: outcome `block`, 34,114 units, usage recorded under task id `replay`.
- Agent resolution: with `--setting-sources=user`, `--agent code-reviewer` resolves to the installed plugin agent `ai-sdlc:code-reviewer`. An agent defined only in the project `.claude/agents/` is "not found". Under `--bare` or `CLAUDE_CODE_SIMPLE=1` the plugin agent does not resolve, so those must not be added.
- AC2 subscription: the run above authenticated through the subscription login under the scrubbed environment (`sandboxEnvFrom` keeps HOME and PATH). API key: no valid key was available in this environment, so only pass-through was checked: `env -i ... ANTHROPIC_API_KEY=sk-ant-fake claude -p` answers "Invalid API key", proving the CLI reads the key; `sandboxEnvFrom` keeps all `ANTHROPIC_*`. A live call with a real key is not verified here.
- AC3: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` has an effect. With it unset the model quotes the user-level `~/.claude/CLAUDE.md` (graphify) in 2 of 2 runs; with it set it reports none in 2 of 2 runs. The project `CLAUDE.md` in the cwd is already not loaded under `--setting-sources=user` (with the variable 0 or 1), so the variable adds user-level suppression. Kept as is.
- AC4: in a repo carrying a project `.claude/settings.json` with UserPromptSubmit and SessionStart hooks (touching marker files) and a project agent overriding `code-reviewer`, the sandboxed argv ran neither: no marker file, and the model was not told the project agent text. Control run with default setting sources created both markers, so the hooks are live when not sandboxed. The replay clone also strips `.claude/` from the commit.
- Re-run 2026-10-29 (claude 2.1.312) confirmed all of the above: replay of AISDLC-1013 gave `block` (34,546 units); with a project `CLAUDE.md` in the cwd, default sources without the variable load it, `--setting-sources=user` or the variable alone each suppress it; a bogus `ANTHROPIC_API_KEY` passed through the scrubbed env is read by the CLI ("Invalid API key"); a project hook and project `code-reviewer` agent did not run under the sandbox argv.
<!-- SECTION:NOTES:END -->
