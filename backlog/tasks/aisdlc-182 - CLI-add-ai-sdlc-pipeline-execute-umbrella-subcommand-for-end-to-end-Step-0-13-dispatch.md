---
id: AISDLC-182
title: >-
  CLI: add ai-sdlc-pipeline execute umbrella subcommand for end-to-end Step 0-13
  dispatch
status: To Do
assignee: []
created_date: '2026-05-04 18:05'
labels:
  - bug
  - pipeline-cli
  - framework-bug
  - developer-experience
dependencies: []
references:
  - pipeline-cli/bin/ai-sdlc-pipeline.mjs
  - pipeline-cli/src/cli/
  - ai-sdlc-plugin/skills/
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - scripts/check-attestation-sign.sh
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The framework currently has no way to invoke the full Step 0-13 pipeline programmatically from a developer/operator's session that has subagent-spawning capability. The existing surfaces are:

1. **`/ai-sdlc execute <task-id>`** — slash command body that runs Steps 0-13 in the operator's Claude Code session. Only the operator can type slash commands; an AI assistant working alongside the operator (e.g., Claude in main conversation) cannot invoke this.
2. **`pnpm --filter @ai-sdlc/dogfood watch --issue <id>`** — programmatic but uses API-key billing (paid Anthropic API), not subscription. Acceptable for the GitHub-issue path; not appropriate for backlog-task internal dogfood per the dual-workflow architecture (subscription billing).
3. **`ai-sdlc-pipeline <step>` per-step subcommands** (sweep-worktrees, validate-task, build-dev-prompt, parse-dev-return, build-review-prompts, aggregate-verdicts, finalize-task, push-and-pr, cleanup-task, etc.) — each step exposed individually, but **no umbrella that composes them into the Step 0-13 sequence**.

## Observed failure mode

2026-05-04 dogfood: while the operator was reviewing PRs, the assistant dispatched developer subagents directly via `Agent({subagent_type: "ai-sdlc:developer"})` and pushed the resulting commits to PRs WITHOUT running the 3 reviewer subagents (Step 7), aggregating verdicts (Step 8), or signing the DSSE attestation envelope (Step 10). Result: ~10 PRs shipped to main without reviewer verdicts or attestation envelopes.

The shortcut was taken precisely because the assistant could NOT invoke `/ai-sdlc execute` (slash-command-only) and the `ai-sdlc-pipeline` CLI's per-step subcommands required manual composition (which the assistant skipped).

## Proposed fix

Add an `ai-sdlc-pipeline execute <task-id>` umbrella subcommand that composes Steps 0-13 in sequence:

```
ai-sdlc-pipeline execute <task-id> [options]
  --max-iterations <N>       Max review iteration loop (default 2; matches /ai-sdlc execute)
  --skip-sweep               Skip Step 0 (worktree sweep)
  --spawner <type>           SubagentSpawner type: claude-cli (default; subscription via local Claude Code) | api-key | mock
  --dry-run                  Plan + log; don't actually dispatch
```

Internally calls the same Step 1-13 logic the slash command body executes. The key difference from the slash command: this is invokable from a non-slash-command context, so an AI assistant in the operator's session can call `node pipeline-cli/bin/ai-sdlc-pipeline.mjs execute <task-id>` and get the full pipeline.

The `--spawner claude-cli` option requires solving the "how does CLI invoke subagents in the calling Claude Code session" problem — likely via the same shell-out mechanism used by the slash command body, OR via a SubagentSpawner adapter that emits Agent-tool-call instructions for the parent context to execute.

If a clean spawner-routing solution isn't feasible in v1, ship `--spawner api-key` first (uses paid Anthropic API per task; matches dogfood `watch` semantics); document as the temporary path for assistant-driven dispatch until subscription routing lands.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/cli/execute.ts implements ExecuteCommand that composes Step 0 through Step 13 in sequence (matching /ai-sdlc execute slash command body)
- [ ] #2 Registered as `execute` subcommand on pipeline-cli/bin/ai-sdlc-pipeline.mjs (visible in --help output)
- [ ] #3 Honors the same hard rules as /ai-sdlc execute: never merge PRs, never close PRs, never delete branches, never edit .ai-sdlc/** or .github/workflows/**, never write CI-skip magic tokens
- [ ] #4 On developer JSON contract violation, invokes the AISDLC-176 retry path (one re-emission attempt before failing with developer-json-contract-violated)
- [ ] #5 On developer-failed outcome, invokes the AISDLC-177 rollback path (revert task status, sweep worktree, quarantine commits)
- [ ] #6 Writes verdict file to .ai-sdlc/verdicts/<task-id-lower>.json after Step 8 aggregate (so the existing pre-push hook can auto-sign the DSSE envelope at Step 10)
- [ ] #7 Runs the 3 reviewer subagents (code-reviewer, test-reviewer, security-reviewer) in parallel per Step 7 — verdict file MUST contain all 3 reviewers
- [ ] #8 Iterates per Step 9 (max 2 iterations) when reviewers report critical/major findings; opens PR with [needs-human-attention] flag if iteration cap exhausted
- [ ] #9 Documented in pipeline-cli/README.md with a comparison table: /ai-sdlc execute (slash) vs ai-sdlc-pipeline execute (CLI) vs pnpm dogfood watch (API key)
- [ ] #10 Until merge: AI assistants helping the operator MUST manually compose Steps 5 + 7 + 8 + 10 + 11 (dispatch dev → dispatch 3 reviewers → aggregate → write verdict file → push for hook auto-sign) on every dispatch. No more skipping reviewers.
<!-- AC:END -->
